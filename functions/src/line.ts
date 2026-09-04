/**
 * LINE Messaging API 封裝：群組 push（含月額度守門）、reply、訊息模板。
 */
import { messagingApi, validateSignature } from '@line/bot-sdk';
import { logger } from 'firebase-functions/v2';
import { LINE_CHANNEL_ACCESS_TOKEN, LINE_CHANNEL_SECRET } from './config.js';
import { Timestamp, db, groupIdForOwner, lineConfigRef } from './db.js';
import { TAIPEI, fmtBoth, fmtDateTime, fmtHours, fmtTime, monthKey, tzLabel } from './time.js';
import type { FlightSegment, PushKind, RecentItem, Trip } from './types.js';
import { currentFlight } from './overdue-logic.js';

export type Message = messagingApi.Message;

/** 免費方案每月則數（以 LINE 官方最新方案為準）。 */
export const MONTHLY_QUOTA = 200;
/** 超過此數只保留警報與恢復通知。 */
export const QUOTA_SOFT_LIMIT = 190;

let _client: messagingApi.MessagingApiClient | null = null;
function client(): messagingApi.MessagingApiClient {
  if (!_client) {
    _client = new messagingApi.MessagingApiClient({ channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN.value() });
  }
  return _client;
}

export function verifyLineSignature(rawBody: Buffer | string, signature: string | undefined): boolean {
  if (!signature) return false;
  return validateSignature(rawBody, LINE_CHANNEL_SECRET.value(), signature);
}

/**
 * 以交易保留一則額度。回傳 false 代表本則應略過。
 */
async function reserveQuota(kind: PushKind, now: Date): Promise<boolean> {
  const key = monthKey(now);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(lineConfigRef);
    const cfg = snap.data();
    const count = cfg && cfg.monthKey === key ? cfg.pushCount : 0;
    if (count >= MONTHLY_QUOTA) return false;
    if (count >= QUOTA_SOFT_LIMIT && kind !== 'alert' && kind !== 'recovery') return false;
    tx.set(lineConfigRef, { monthKey: key, pushCount: count + 1 }, { merge: true });
    return true;
  });
}

/**
 * 推播到已綁定的家人群組。群組為單一收件對象，一次 push 不論物件數與人數只計 1 則。
 * 回傳是否實際送出。
 */
export async function pushGroup(ownerUid: string, kind: PushKind, messages: Message[], now = new Date()): Promise<boolean> {
  const groupId = await groupIdForOwner(ownerUid);
  if (!groupId) {
    logger.warn('pushGroup skipped: owner has no bound group', { kind, ownerUid });
    return false;
  }
  if (!(await reserveQuota(kind, now))) {
    logger.warn('pushGroup skipped: quota', { kind });
    return false;
  }
  try {
    await client().pushMessage({ to: groupId, messages: messages.slice(0, 5) });
    return true;
  } catch (err) {
    logger.error('pushGroup failed', { kind, err: String(err) });
    return false;
  }
}

/**
 * 下載使用者傳給官方帳號的圖片內容。emulator 下支援 `e2e:<base64>` 假 messageId 以便測試。
 */
export async function downloadMessageContent(messageId: string, maxBytes: number): Promise<{ data: Buffer; contentType: string } | null> {
  if (process.env.FUNCTIONS_EMULATOR === 'true' && messageId.startsWith('e2e:')) {
    return { data: Buffer.from(messageId.slice(4), 'base64'), contentType: 'image/jpeg' };
  }
  const res = await fetch(`https://api-data.line.me/v2/bot/message/${encodeURIComponent(messageId)}/content`, {
    headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN.value()}` },
  });
  if (!res.ok) {
    logger.warn('downloadMessageContent failed', { status: res.status });
    return null;
  }
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > maxBytes) return null;
  const data = Buffer.from(await res.arrayBuffer());
  if (data.length > maxBytes) return null;
  return { data, contentType: res.headers.get('content-type') ?? 'image/jpeg' };
}

export async function reply(replyToken: string, messages: Message[]): Promise<void> {
  try {
    await client().replyMessage({ replyToken, messages: messages.slice(0, 5) });
  } catch (err) {
    logger.error('reply failed', { err: String(err) });
  }
}

// ---------- 訊息模板 ----------

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

export function textMsg(text: string): messagingApi.TextMessage {
  return { type: 'text', text: clip(text, 5000) };
}

export function locationMsg(title: string, address: string, lat: number, lng: number): messagingApi.LocationMessage {
  return {
    type: 'location',
    title: clip(title, 100),
    address: clip(address || '—', 100),
    latitude: lat,
    longitude: lng,
  };
}

function lastReportLine(trip: Trip, now: Date): string {
  if (!trip.lastCheckinAt) return '尚無任何回報';
  const last = trip.lastCheckinAt.toDate();
  const ago = fmtHours((now.getTime() - last.getTime()) / 3_600_000);
  const where = trip.lastCheckinPlace ? `於 ${trip.lastCheckinPlace} ` : '';
  return `最後回報 ${where}${fmtBoth(last, trip.travelerTz)}，${ago}前`;
}

function flightWindows(trip: Trip) {
  return (trip.flights ?? []).map((f) => ({ ...f, departAt: f.departAt.toDate(), arriveAt: f.arriveAt.toDate() }));
}

/** 飛行中的一行描述，非飛行中回傳 null。 */
export function flightLine(trip: Trip, now: Date): string | null {
  const f = currentFlight(flightWindows(trip), now);
  if (!f) return null;
  return `✈️ 飛行中 ${f.flightNo} ${f.fromCity} → ${f.toCity}，預計 ${fmtBoth(f.arriveAt, f.toTz)} 降落`;
}

/** 下一段尚未起飛的航段描述。 */
export function nextFlightLine(trip: Trip, now: Date): string | null {
  const f = flightWindows(trip).find((x) => x.departAt.getTime() > now.getTime());
  if (!f) return null;
  return `下一段 ${f.flightNo} ${f.fromCity} → ${f.toCity}，${fmtBoth(f.departAt, f.fromTz)} 起飛`;
}

export function flightSummary(f: FlightSegment): string {
  return `${f.flightNo} ${f.fromCity} ${fmtDateTime(f.departAt.toDate(), f.fromTz)} → ${f.toCity} ${fmtDateTime(f.arriveAt.toDate(), f.toTz)}（各地當地時間）`;
}

function nowLine(trip: Trip, now: Date): string {
  const tpe = `台北現在 ${fmtTime(now, TAIPEI)}`;
  if (trip.travelerTz === TAIPEI) return tpe;
  return `${tpe}，${tzLabel(trip.travelerTz)}當地 ${fmtTime(now, trip.travelerTz)}`;
}

export function startMessages(trip: Trip, url: string): Message[] {
  const s = fmtDateTime(trip.startAt.toDate(), TAIPEI);
  const e = fmtDateTime(trip.endAt.toDate(), TAIPEI);
  const flights = (trip.flights ?? []).slice(0, 6).map((f) => `• ${flightSummary(f)}`);
  return [
    textMsg(
      `🧳 行程開始：${trip.title}\n${s} → ${e}（台北）\n預計每 ${trip.intervalHours} 小時回報一次。\n` +
        (flights.length ? `航段：\n${flights.join('\n')}\n` : '') +
        `逾時未回報時會在這裡提醒。查看地圖與時間軸：${url}`,
    ),
  ];
}

export function endMessages(trip: Trip, reason: string, url: string): Message[] {
  return [textMsg(`✅ 行程結束：${trip.title}\n${reason}\n完整紀錄：${url}`)];
}

export function offlineMessages(trip: Trip, until: Date, url: string): Message[] {
  return [
    textMsg(
      `✈️ ${trip.title}：預告離線\n預計 ${fmtBoth(until, trip.travelerTz)} 前不會回報，期間不會發出警報。\n${url}`,
    ),
  ];
}

export function recoveryMessages(
  trip: Trip,
  lat: number,
  lng: number,
  at: Date,
  tz: string,
  place: string | null,
  note: string,
  url: string,
): Message[] {
  const where = place ?? tzLabel(tz);
  return [
    locationMsg(`✅ ${trip.title} 已恢復回報 · ${where}`, `${fmtBoth(at, tz)}${note ? ` · ${note}` : ''}`, lat, lng),
    textMsg(`已恢復回報 · ${where}\n${fmtBoth(at, tz)}${note ? `\n備註：${note}` : ''}\n${url}`),
  ];
}

export interface AlertOpts {
  overdueH: number;
  morning?: boolean;
  final?: boolean;
}

export function alertMessages(trip: Trip, opts: AlertOpts, url: string, now = new Date()): Message[] {
  const prefix = opts.morning ? '（早安補發）' : '';
  const head = `${prefix}⚠️ ${trip.title} 尚未回報`;
  const landed = flightWindows(trip)
    .filter((f) => f.arriveAt.getTime() <= now.getTime() && now.getTime() - f.arriveAt.getTime() < 24 * 3_600_000)
    .pop();
  const landedLine = landed ? `${landed.flightNo} 預計已於 ${fmtBoth(landed.arriveAt, landed.toTz)} 降落 ${landed.toCity}。\n` : '';
  const body =
    `已超過預定回報時間 ${fmtHours(opts.overdueH)}。\n${landedLine}` +
    `${lastReportLine(trip, now)}。\n${nowLine(trip, now)}。\n` +
    `查看地圖與時間軸：${url}` +
    (opts.final ? '\n\n這是最後一次自動提醒，之後請直接聯絡本人或查看家人頁。' : '');
  const msgs: Message[] = [];
  if (trip.lastCheckinGeo && trip.lastCheckinAt) {
    msgs.push(
      locationMsg(
        head,
        `最後回報 ${fmtBoth(trip.lastCheckinAt.toDate(), trip.travelerTz)}`,
        trip.lastCheckinGeo.latitude,
        trip.lastCheckinGeo.longitude,
      ),
    );
  }
  msgs.push(textMsg(`${head}\n${body}`));
  return msgs;
}

/** 「在哪」回覆。 */
export function whereMessages(trip: Trip, url: string, now = new Date()): Message[] {
  const msgs: Message[] = [];
  const status =
    trip.offlineUntil && trip.offlineUntil.toDate() > now
      ? `預告離線至 ${fmtBoth(trip.offlineUntil.toDate(), trip.travelerTz)}`
      : trip.alerted
        ? '⚠️ 目前逾時未回報'
        : `下次期限 ${fmtBoth(trip.nextDeadlineAt.toDate(), trip.travelerTz)}`;
  if (trip.lastCheckinGeo && trip.lastCheckinAt) {
    msgs.push(
      locationMsg(
        `${trip.title} 最後位置${trip.lastCheckinPlace ? ` · ${trip.lastCheckinPlace}` : ''}`,
        fmtBoth(trip.lastCheckinAt.toDate(), trip.travelerTz),
        trip.lastCheckinGeo.latitude,
        trip.lastCheckinGeo.longitude,
      ),
    );
  }
  const fl = flightLine(trip, now) ?? nextFlightLine(trip, now);
  msgs.push(textMsg(`${lastReportLine(trip, now)}。\n${status}。${fl ? `\n${fl}。` : ''}\n${nowLine(trip, now)}。\n${url}`));
  return msgs;
}

/** 「行程」回覆：最近 5 筆。 */
export function recentListMessages(trip: Trip, recent: RecentItem[], url: string): Message[] {
  const lines = recent.slice(0, 5).map((r) => {
    const at = r.at instanceof Timestamp ? r.at.toDate() : new Date(r.at as unknown as string);
    return `• ${fmtBoth(at, r.tz)} ${r.place ?? tzLabel(r.tz)}${r.note ? ` · ${r.note}` : ''}`;
  });
  const body = lines.length ? lines.join('\n') : '尚無回報';
  return [textMsg(`${trip.title} 最近回報\n${body}\n${url}`)];
}
