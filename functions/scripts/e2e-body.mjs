/**
 * 在 emulator 內執行的測試本體（由 e2e.mjs 透過 emulators:exec 呼叫）。
 * 環境變數 FIRESTORE_EMULATOR_HOST 由 emulators:exec 注入。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeApp } from 'firebase-admin/app';
import { Timestamp, getFirestore } from 'firebase-admin/firestore';

const here = dirname(fileURLToPath(import.meta.url));
const fnDir = resolve(here, '..');

// 讀 .secret.local 取得 WRITE_TOKEN（與 emulator 內 functions 看到的一致）
const secrets = Object.fromEntries(
  readFileSync(resolve(fnDir, '.secret.local'), 'utf8')
    .split('\n')
    .filter((l) => l.includes('='))
    .map((l) => l.split('=', 2)),
);
const PROJECT = 'demo-iamalive';
const REGION = 'asia-east1';
const FN_HOST = process.env.FUNCTIONS_EMULATOR_HOST ?? '127.0.0.1:5001';
const BASE = `http://${FN_HOST}/${PROJECT}/${REGION}/api/api`;
const WH = `http://${FN_HOST}/${PROJECT}/${REGION}/lineWebhook`;

process.env.GCLOUD_PROJECT = PROJECT;
initializeApp({ projectId: PROJECT });
const db = getFirestore();

let step = 0;
const log = (m) => console.log(`[e2e ${String(++step).padStart(2, '0')}] ${m}`);

/** 目前預設身分：{ apiKey } | { cookie } | { legacy } | null */
let AUTH = null;
function authHeaders(auth = AUTH) {
  if (!auth) return {};
  if (auth.apiKey) return { 'x-api-key': auth.apiKey };
  if (auth.cookie) return { cookie: auth.cookie, origin: `http://${FN_HOST}` };
  if (auth.legacy) return { 'x-write-token': auth.legacy };
  return {};
}

async function call(method, path, body, auth = AUTH) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...authHeaders(auth) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* ignore */
  }
  return { status: res.status, json, headers: res.headers };
}

async function devLogin(uid, name) {
  const r = await call('POST', '/auth/dev-login', { uid, name }, null);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const sc = r.headers.get('set-cookie') ?? '';
  const m = sc.match(/__session=([^;]+)/);
  assert.ok(m, 'session cookie set');
  return { cookie: `__session=${m[1]}` };
}

/** 送一則已簽章的 webhook 事件。 */
async function webhookEvent(event) {
  const { createHmac } = await import('node:crypto');
  const body = JSON.stringify({ destination: 'x', events: [event] });
  const sig = createHmac('sha256', secrets.LINE_CHANNEL_SECRET).update(body).digest('base64');
  const r = await fetch(WH, { method: 'POST', headers: { 'content-type': 'application/json', 'x-line-signature': sig }, body });
  assert.equal(r.status, 200);
}
const groupSrc = (groupId, userId) => ({ type: 'group', groupId, userId });
const textEvent = (groupId, userId, text) => ({ type: 'message', replyToken: 'r', timestamp: Date.now(), source: groupSrc(groupId, userId), message: { id: '1', type: 'text', text } });
const locationEvent = (groupId, userId, lat, lng, title) => ({ type: 'message', replyToken: 'r', timestamp: Date.now(), source: groupSrc(groupId, userId), message: { id: '2', type: 'location', title, address: '', latitude: lat, longitude: lng } });

async function waitForFunctions() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('functions emulator not reachable');
}

const H = 3_600_000;

async function main() {
  await waitForFunctions();
  log('functions emulator ready');

  // ---- 認證：未登入 401 → dev-login → 金鑰 → 舊 token 對應 ----
  const A_UID = secrets.TRAVELER_LINE_UID; // 舊 WRITE_TOKEN 對應到這位
  const B_UID = 'Ub2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2';
  let r = await call('GET', '/status', undefined, null);
  assert.equal(r.status, 401, 'no auth must be 401');
  r = await call('GET', '/status', undefined, { apiKey: 'ak_nope' });
  assert.equal(r.status, 401, 'bad key must be 401');

  const sessA = await devLogin(A_UID, '旅人 A');
  r = await call('GET', '/status', undefined, sessA);
  assert.equal(r.status, 200);
  assert.equal(r.json.user.uid, A_UID);
  assert.equal(r.json.user.kind, 'session');
  assert.equal(r.json.groupBound, false);
  assert.equal(r.json.activeTrip, null);
  log('login + status ok');

  // CSRF：cookie 身分的 POST 若 sec-fetch-site=cross-site 要 403
  {
    const res = await fetch(`${BASE}/trips`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: sessA.cookie, 'sec-fetch-site': 'cross-site' }, body: '{}' });
    assert.equal(res.status, 403, 'cross-site cookie POST rejected');
  }

  r = await call('POST', '/keys', { label: 'iPhone' }, sessA);
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.ok(r.json.key.startsWith('ak_'));
  const KEY = r.json.key;
  AUTH = { apiKey: KEY };
  r = await call('GET', '/keys', undefined, sessA);
  assert.equal(r.json.length, 1);
  assert.equal(r.json[0].label, 'iPhone');
  r = await call('GET', '/status');
  assert.equal(r.json.user.kind, 'apikey');
  assert.equal(r.json.user.uid, A_UID);
  r = await call('GET', '/status', undefined, { legacy: secrets.WRITE_TOKEN });
  assert.equal(r.status, 200);
  assert.equal(r.json.user.uid, A_UID, 'legacy write token maps to traveler uid');
  assert.equal(r.json.user.kind, 'legacy');
  log('api key + legacy token ok');

  // 建立行程
  const now = new Date();
  r = await call('POST', '/trips', {
    title: 'E2E 東京',
    startAt: new Date(now.getTime() - 48 * H).toISOString(), // 早於所有以「今天台北時間」構造的掃描時刻
    endAt: new Date(now.getTime() + 7 * 24 * H).toISOString(),
    intervalHours: 12,
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const trip = r.json;
  assert.equal(trip.status, 'active');
  assert.equal(trip.travelerTz, 'Asia/Taipei');
  assert.ok(trip.groupReadToken.length >= 16);
  const firstDeadline = new Date(trip.nextDeadlineAt);
  assert.ok(Math.abs(firstDeadline.getTime() - (now.getTime() + 12 * H)) < 60_000, 'first deadline = now + 12h');
  log(`trip created ${trip.id}, family ${trip.familyUrl}`);

  r = await call('POST', '/trips', { title: 'dup', startAt: now.toISOString(), endAt: new Date(now.getTime() + H).toISOString(), intervalHours: 1 });
  assert.equal(r.status, 409);
  log('second active trip rejected');

  // view 已建立且可匿名 get（規則由 emulator 套用；這裡用 admin 讀確認內容）
  let view = (await db.doc(`views/${trip.groupReadToken}`).get()).data();
  assert.equal(view.tripId, trip.id);
  assert.equal(view.label, '群組');
  assert.deepEqual(view.recent, []);
  log('group view created');

  // 打卡：東京座標 → tz 應為 Asia/Tokyo
  r = await call('POST', '/checkin', {
    lat: 35.6812,
    lng: 139.7671,
    source: 'shortcut',
    note: '抵達東京車站',
    clientAt: new Date().toISOString(),
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.tz, 'Asia/Tokyo');
  assert.equal(r.json.pushed, false, '未綁定群組不推播');
  assert.equal(r.json.recovered, false);
  log('checkin (Tokyo) ok, tz=Asia/Tokyo');

  view = (await db.doc(`views/${trip.groupReadToken}`).get()).data();
  assert.equal(view.recent.length, 1);
  assert.equal(view.recent[0].tz, 'Asia/Tokyo');
  assert.equal(view.recent[0].note, '抵達東京車站');
  assert.ok('place' in view.recent[0], 'recent item has place field');
  console.log('      place =', view.recent[0].place);
  assert.equal(view.travelerTz, 'Asia/Tokyo');
  log('view projection updated');

  // 打卡帶 nextHours=16
  r = await call('POST', '/checkin', { lat: 35.68, lng: 139.76, source: 'manual', nextHours: 16 });
  assert.equal(r.status, 200);
  const dl16 = new Date(r.json.nextDeadlineAt);
  assert.ok(Math.abs(dl16.getTime() - (Date.now() + 16 * H)) < 60_000, 'deadline = now + 16h');
  log('checkin with nextHours=16 ok');

  // 照片打卡（multipart）：1x1 JPEG，帶 takenAt
  {
    const jpeg = Buffer.from(
      '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==',
      'base64',
    );
    const fd = new FormData();
    fd.append('lat', '46.6863');
    fd.append('lng', '7.8632'); // Interlaken
    fd.append('note', '少女峰');
    fd.append('takenAt', new Date(Date.now() - 2 * H).toISOString());
    fd.append('photo', new Blob([jpeg], { type: 'image/jpeg' }), 'p.jpg');
    const res0 = await fetch(`${BASE}/checkin/photo`, { method: 'POST', headers: authHeaders(), body: fd });
    const j0 = await res0.json();
    assert.equal(res0.status, 200, JSON.stringify(j0));
    assert.equal(j0.tz, 'Europe/Zurich');
    assert.ok(j0.photoId);
    view = (await db.doc(`views/${trip.groupReadToken}`).get()).data();
    assert.equal(view.recent[0].photoId, j0.photoId);
    assert.equal(view.recent[0].src, 'photo');
    assert.ok(view.recent[0].takenAt, 'takenAt stored');
    // 家人頁取圖：正確 token 200、錯誤 token 404
    const img = await fetch(`${BASE}/p/${trip.groupReadToken}/${j0.photoId}`);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/jpeg');
    assert.equal((await img.arrayBuffer()).byteLength, jpeg.length);
    const bad = await fetch(`${BASE}/p/notavalidtoken_notavalid/${j0.photoId}`);
    assert.equal(bad.status, 404);
    // 沒有檔案 → 400；非圖片 → 415
    const fd2 = new FormData();
    fd2.append('lat', '1');
    fd2.append('lng', '1');
    assert.equal((await fetch(`${BASE}/checkin/photo`, { method: 'POST', headers: authHeaders(), body: fd2 })).status, 400);
    const fd3 = new FormData();
    fd3.append('lat', '1');
    fd3.append('lng', '1');
    fd3.append('photo', new Blob(['hi'], { type: 'text/plain' }), 'x.txt');
    assert.equal((await fetch(`${BASE}/checkin/photo`, { method: 'POST', headers: authHeaders(), body: fd3 })).status, 415);
    log('photo checkin + photo serving ok');

    // 刪除該筆打卡：紀錄消失、照片 404、view 更新、最後回報退回前一筆、期限不變
    const before = (await db.doc(`trips/${trip.id}`).get()).data();
    const delRes = await call('DELETE', `/trips/${trip.id}/checkins/${view.recent[0].id}`);
    assert.equal(delRes.status, 200, JSON.stringify(delRes.json));
    view = (await db.doc(`views/${trip.groupReadToken}`).get()).data();
    assert.equal(view.recent.length, 2);
    assert.ok(view.recent.every((x) => x.id && x.photoId == null));
    assert.equal((await fetch(`${BASE}/p/${trip.groupReadToken}/${j0.photoId}`)).status, 404, 'photo removed');
    const after = (await db.doc(`trips/${trip.id}`).get()).data();
    assert.equal(after.travelerTz, 'Asia/Tokyo', 'last fields recomputed from previous checkin');
    assert.equal(after.nextDeadlineAt.toMillis(), before.nextDeadlineAt.toMillis(), 'deadline unchanged');
    assert.equal((await call('DELETE', `/trips/${trip.id}/checkins/nope`)).status, 404);
    log('delete checkin (with photo) ok');
  }

  // 驗證錯誤
  r = await call('POST', '/checkin', { lat: 999, lng: 0 });
  assert.equal(r.status, 400);
  r = await call('POST', '/checkin', { lat: 1, lng: 1, note: 'x'.repeat(201) });
  assert.equal(r.status, 400);
  log('validation errors ok');

  // 預告離線
  r = await call('POST', `/trips/${trip.id}/offline`, { hours: 10 });
  assert.equal(r.status, 200);
  const offUntil = new Date(r.json.offlineUntil);
  assert.ok(Math.abs(offUntil.getTime() - (Date.now() + 10 * H)) < 60_000);
  assert.ok(Math.abs(new Date(r.json.nextDeadlineAt).getTime() - (offUntil.getTime() + 12 * H)) < 60_000, 'deadline = offlineUntil + interval');
  log('offline announcement ok');

  // 家人連結
  r = await call('POST', `/trips/${trip.id}/watchers`, { label: '媽媽' });
  assert.equal(r.status, 201);
  const momToken = r.json.token;
  r = await call('GET', `/trips/${trip.id}/watchers`);
  assert.equal(r.json.length, 2);
  view = (await db.doc(`views/${momToken}`).get()).data();
  assert.equal(view.label, '媽媽');
  assert.equal(view.recent.length, 2, 'new watcher gets existing history');
  r = await call('DELETE', `/trips/${trip.id}/watchers/${momToken}`);
  assert.equal(r.status, 200);
  assert.equal((await db.doc(`views/${momToken}`).get()).exists, false);
  r = await call('DELETE', `/trips/${trip.id}/watchers/${trip.groupReadToken}`);
  assert.equal(r.status, 400, 'group token cannot be removed');
  log('watcher add/list/remove ok');

  // ---- 使用者隔離 ----
  const sessB = await devLogin(B_UID, '旅人 B');
  r = await call('GET', '/trips/active', undefined, sessB);
  assert.equal(r.status, 404, 'B has no active trip');
  r = await call('GET', `/trips/${trip.id}/watchers`, undefined, sessB);
  assert.equal(r.status, 404, "B cannot see A's trip");
  r = await call('POST', '/checkin', { lat: 1, lng: 1 }, sessB);
  assert.equal(r.status, 409, 'B has no trip to check in');
  r = await call('GET', '/trips', undefined, sessB);
  assert.deepEqual(r.json, []);
  log('per-user isolation ok');

  // ---- 群組綁定碼 + webhook 路由 ----
  const G = 'C' + 'a'.repeat(32);
  await webhookEvent(textEvent(G, A_UID, '綁定 000000'));
  assert.equal((await db.doc(`groups/${G}`).get()).exists, false, 'invalid code does not bind');
  r = await call('POST', '/line/bind-code', undefined, sessA);
  assert.equal(r.status, 200);
  const code = r.json.code;
  assert.match(code, /^\d{6}$/);
  await webhookEvent(textEvent(G, B_UID, `綁定 ${code}`));
  assert.equal((await db.doc(`groups/${G}`).get()).exists, false, "someone else cannot use A's code");
  await webhookEvent(textEvent(G, A_UID, `綁定 ${code}`));
  const gdoc = (await db.doc(`groups/${G}`).get()).data();
  assert.equal(gdoc?.ownerUid, A_UID, 'group bound to A');
  assert.equal((await db.doc(`bindCodes/${code}`).get()).exists, false, 'code consumed');
  r = await call('GET', '/status', undefined, sessA);
  assert.equal(r.json.groupBound, true);
  // 擁有者在群組傳位置 → 打卡；別人傳 → 忽略
  const beforeN = ((await db.doc(`views/${trip.groupReadToken}`).get()).data()).recent.length;
  await webhookEvent(locationEvent(G, B_UID, 48.85, 2.35, '巴黎'));
  assert.equal(((await db.doc(`views/${trip.groupReadToken}`).get()).data()).recent.length, beforeN, 'non-owner location ignored');
  await webhookEvent(locationEvent(G, A_UID, 48.8584, 2.2945, '艾菲爾鐵塔'));
  view = (await db.doc(`views/${trip.groupReadToken}`).get()).data();
  assert.equal(view.recent.length, beforeN + 1);
  assert.equal(view.recent[0].src, 'line');
  assert.equal(view.recent[0].tz, 'Europe/Paris');
  // 重綁另一個群組會解除舊群組
  r = await call('POST', '/line/bind-code', undefined, sessA);
  const G2 = 'C' + 'b'.repeat(32);
  await webhookEvent(textEvent(G2, A_UID, `綁定 ${r.json.code}`));
  assert.equal((await db.doc(`groups/${G}`).get()).exists, false, 'old group unbound');
  assert.equal((await db.doc(`groups/${G2}`).get()).data()?.ownerUid, A_UID);
  // leave 事件解除綁定
  await webhookEvent({ type: 'leave', timestamp: Date.now(), source: { type: 'group', groupId: G2 } });
  assert.equal((await db.doc(`groups/${G2}`).get()).exists, false, 'leave removes binding');
  log('bind code + webhook routing ok');

  // ---- 逾時狀態機（直接呼叫編譯後的 runOverdueScan，Firestore 指向 emulator） ----
  for (const [k, v] of Object.entries(secrets)) process.env[k] = v;
  process.env.PUBLIC_BASE_URL = 'http://localhost:5000';
  const { runOverdueScan } = await import(resolve(fnDir, 'lib/overdue.js'));

  const tripRef = db.doc(`trips/${trip.id}`);
  // 清掉離線、把期限設成 1 小時前；用台北 12:00 當 now
  const NOON = tpeDate('12:00');
  await tripRef.update({ offlineUntil: null, nextDeadlineAt: Timestamp.fromDate(new Date(NOON.getTime() - H)) });

  let res = await runOverdueScan(NOON);
  assert.deepEqual(res, { scanned: 1, alerts: 1, completed: 0 });
  let t = (await tripRef.get()).data();
  assert.equal(t.alerted, true);
  assert.equal(t.alertCount, 1);
  assert.equal(t.morningResendDue, false);
  log('first alert at noon');

  res = await runOverdueScan(new Date(NOON.getTime() + 1 * H));
  assert.equal(res.alerts, 0, 'no repeat before 3h');
  res = await runOverdueScan(new Date(NOON.getTime() + 3 * H));
  assert.equal(res.alerts, 1);
  t = (await tripRef.get()).data();
  assert.equal(t.alertCount, 2);
  log('repeat after 3h');

  // 推到上限
  await runOverdueScan(new Date(NOON.getTime() + 6 * H));
  await runOverdueScan(new Date(NOON.getTime() + 9 * H));
  t = (await tripRef.get()).data();
  assert.equal(t.alertCount, 4);
  res = await runOverdueScan(new Date(NOON.getTime() + 12 * H));
  assert.equal(res.alerts, 0, 'capped at MAX_ALERTS');
  log('capped at 4 alerts');

  // 夜間警報 → 早晨補發
  await tripRef.update({
    alerted: false,
    alertCount: 0,
    lastAlertAt: null,
    morningResendDue: false,
    morningResent: false,
    nextDeadlineAt: Timestamp.fromDate(new Date(tpeDate('02:00').getTime() - H)),
  });
  res = await runOverdueScan(tpeDate('02:00'));
  assert.equal(res.alerts, 1);
  t = (await tripRef.get()).data();
  assert.equal(t.morningResendDue, true, 'night alert flags morning resend');
  res = await runOverdueScan(tpeDate('07:45'));
  t = (await tripRef.get()).data();
  assert.equal(t.morningResent, false, 'not before 08:00');
  res = await runOverdueScan(tpeDate('08:05'));
  assert.equal(res.alerts, 1);
  t = (await tripRef.get()).data();
  assert.equal(t.morningResent, true);
  assert.equal(t.morningResendDue, false);
  res = await runOverdueScan(tpeDate('08:20'));
  assert.equal(res.alerts, 0, 'morning resend only once');
  log('quiet-hours morning resend ok');

  // 打卡 → 恢復，旗標歸零
  r = await call('POST', '/checkin', { lat: 35.68, lng: 139.76, source: 'shortcut' });
  assert.equal(r.status, 200);
  assert.equal(r.json.recovered, true);
  t = (await tripRef.get()).data();
  assert.equal(t.alerted, false);
  assert.equal(t.alertCount, 0);
  assert.equal(t.morningResent, false);
  view = (await db.doc(`views/${trip.groupReadToken}`).get()).data();
  assert.equal(view.alerted, false);
  log('checkin after alert = recovered, flags reset');

  // ---- 航段：期限落在飛行中 → 順延到降落 + 3h ----
  // 用固定 UTC 時刻，避開安靜時段：起飛 台北 09/10 12:00 (04:00Z)，降落 維也納 09/10 18:00 (16:00Z, CEST)
  r = await call('PUT', `/trips/${trip.id}/flights`, {
    flights: [
      { flightNo: 'br61', fromCity: '台北', fromTz: 'Asia/Taipei', departLocal: '2026-09-10T12:00', toCity: '維也納', toTz: 'Europe/Vienna', arriveLocal: '2026-09-10T18:00' },
    ],
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.flights[0].flightNo, 'BR61');
  assert.equal(r.json.flights[0].departAt, '2026-09-10T04:00:00.000Z');
  assert.equal(r.json.flights[0].arriveAt, '2026-09-10T16:00:00.000Z');
  assert.equal(r.json.flights[0].arriveLocal, '09/10 18:00');
  r = await call('GET', '/trips/active');
  assert.equal(r.json.flights.length, 1);
  view = (await db.doc(`views/${trip.groupReadToken}`).get()).data();
  assert.equal(view.flights.length, 1, 'view projection carries flights');
  r = await call('PUT', `/trips/${trip.id}/flights`, { flights: [{ flightNo: 'X1', fromCity: 'a', fromTz: 'Nope/Zone', departLocal: '2026-09-10T12:00', toCity: 'b', toTz: 'Asia/Taipei', arriveLocal: '2026-09-10T13:00' }] });
  assert.equal(r.status, 400, 'invalid tz rejected');
  log('flights set + validated');

  const dep = new Date('2026-09-10T04:00:00Z');
  const arr = new Date('2026-09-10T16:00:00Z');
  await tripRef.update({ alerted: false, alertCount: 0, lastAlertAt: null, morningResendDue: false, morningResent: false, offlineUntil: null,
    nextDeadlineAt: Timestamp.fromDate(new Date(dep.getTime() + 2 * H)) });
  res = await runOverdueScan(new Date(dep.getTime() + 6 * H));          // 飛行中（台北 18:00）
  assert.equal(res.alerts, 0, 'no alert in flight');
  res = await runOverdueScan(new Date(arr.getTime() + 2 * H));          // 落地 2h（台北 09/11 02:00，安靜時段但仍不到寬限）
  assert.equal(res.alerts, 0, 'no alert within landing grace');
  res = await runOverdueScan(new Date(arr.getTime() + 3.5 * H));        // 落地 3.5h
  assert.equal(res.alerts, 1, 'alert after landing grace');
  t = (await tripRef.get()).data();
  assert.equal(t.alerted, true);
  log('flight window suppresses alerts until landing + grace');
  await call('PUT', `/trips/${trip.id}/flights`, { flights: [] });
  await tripRef.update({ alerted: false, alertCount: 0, lastAlertAt: null, morningResendDue: false, morningResent: false });

  // 自動結案：endAt 25 小時前
  await tripRef.update({
    endAt: Timestamp.fromDate(new Date(Date.now() - 25 * H)),
    nextDeadlineAt: Timestamp.fromDate(new Date(Date.now() - H)),
  });
  res = await runOverdueScan(new Date());
  assert.deepEqual(res, { scanned: 1, alerts: 0, completed: 1 });
  t = (await tripRef.get()).data();
  assert.equal(t.status, 'completed');
  view = (await db.doc(`views/${trip.groupReadToken}`).get()).data();
  assert.equal(view.status, 'completed');
  log('auto-complete 24h after endAt');

  r = await call('GET', '/trips/active');
  assert.equal(r.status, 404);
  r = await call('POST', '/checkin', { lat: 1, lng: 1 });
  assert.equal(r.status, 409);
  log('no active trip after completion');

  // 撤銷金鑰 → 401
  r = await call('GET', '/keys', undefined, sessA);
  r = await call('DELETE', `/keys/${r.json[0].id}`, undefined, sessA);
  assert.equal(r.status, 200);
  r = await call('GET', '/status');
  assert.equal(r.status, 401, 'revoked key rejected');
  AUTH = sessA;
  r = await call('POST', '/auth/logout', undefined, sessA);
  assert.match(r.headers.get('set-cookie') ?? '', /Max-Age=0/);
  log('key revoke + logout ok');

  // webhook 簽章：錯誤簽章 401
  const bad = await fetch(WH, { method: 'POST', headers: { 'content-type': 'application/json', 'x-line-signature': 'nope' }, body: '{"events":[]}' });
  assert.equal(bad.status, 401);
  // 正確簽章 200（用 .secret.local 的 channel secret 算 HMAC）
  const { createHmac } = await import('node:crypto');
  const body = JSON.stringify({ destination: 'x', events: [] });
  const sig = createHmac('sha256', secrets.LINE_CHANNEL_SECRET).update(body).digest('base64');
  const good = await fetch(WH, { method: 'POST', headers: { 'content-type': 'application/json', 'x-line-signature': sig }, body });
  assert.equal(good.status, 200);
  log('webhook signature check ok');

  console.log('\n[e2e] ALL PASSED');
}

/** 今天台北時間 HH:mm 的 Date。 */
function tpeDate(hhmm) {
  const [hh, mm] = hhmm.split(':').map(Number);
  const now = new Date();
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(now)
      .map((x) => [x.type, x.value]),
  );
  // 台北 = UTC+8，無夏令時間
  return new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), hh - 8, mm));
}

main().catch((err) => {
  console.error('\n[e2e] FAILED at step', step, '\n', err);
  process.exit(1);
});
