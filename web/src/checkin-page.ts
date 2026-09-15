/**
 * /c/{token}：免登入打卡頁。每個行程一個能力型 token，旅人把此頁加到 iPhone 主畫面當捷徑。
 * 只能看該行程摘要與打卡（定位 / 拍照 / 選照片），不能改行程。
 */
import { ApiError, api } from './api';
import { extractPhotoMeta, fmtBytes, shrinkImage } from './photo';
import { fmtAgo, fmtBoth } from './time';
import type { CheckinPageJson } from './types';
import { renderShareBar } from './share';
import { renderForecast } from './forecast';
import L from 'leaflet';
import { Timestamp } from 'firebase/firestore';
import { TrackLayer, createMap, renderTimeline } from './mapview';
import type { CheckinJson, RecentItem } from './types';
import { applyPwaIdentity } from './pwa';

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

const ERR: Record<string, string> = {
  TRIP_NOT_FOUND: '連結無效，請到管理頁重新取得打卡頁連結',
  TRIP_ENDED: '這趟行程已結束',
  AT_OUT_OF_RANGE: '拍攝時間不在過去 7 天內，無法作為打卡時間',
  VALIDATION: '欄位格式錯誤',
  PHOTO_REQUIRED: '沒有收到照片',
  UNSUPPORTED_IMAGE_TYPE: '不支援的圖片格式',
  FILE_TOO_LARGE: '照片超過 8 MB',
};
const errText = (e: unknown): string => (e instanceof ApiError ? (ERR[e.code] ?? e.message) : String((e as Error)?.message ?? e));

export function renderCheckinPage(root: HTMLElement, token: string): () => void {
  let info: CheckinPageJson | null = null;
  applyPwaIdentity('checkin');
  let timer: number | null = null;
  let photoState: { file: File; lat: number | null; lng: number | null; accuracy: number | null; takenAt: Date | null } | null = null;

  const toast = (msg: string, kind: 'ok' | 'err' = 'ok'): void => {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = msg;
    document.body.appendChild(el);
    window.setTimeout(() => el.remove(), 4000);
  };

  root.innerHTML = `
    <div class="page checkin-page">
      <section class="status" id="cp-status"><p class="muted">載入中…</p></section>
      <section class="card">
        <label>備註<input id="cp-note" maxlength="200" placeholder="可空，例如：已到飯店" /></label>
        <label>下次回報（小時，可空）<input id="cp-next" type="number" min="1" max="168" step="1" inputmode="numeric" /></label>
        <div class="action-grid">
          <button id="cp-gps" type="button" class="tile"><span class="ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12Z"/><circle cx="12" cy="10" r="2.6"/></svg></span><span class="lbl">定位打卡</span></button>
          <button id="cp-take" type="button" class="tile"><span class="ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8.5A1.5 1.5 0 0 1 5.5 7H8l1.4-2h5.2L16 7h2.5A1.5 1.5 0 0 1 20 8.5v9A1.5 1.5 0 0 1 18.5 19h-13A1.5 1.5 0 0 1 4 17.5v-9Z"/><circle cx="12" cy="13" r="3.4"/></svg></span><span class="lbl">拍照打卡</span></button>
          <button id="cp-choose" type="button" class="tile"><span class="ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="5" width="16" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m20 15-4.5-4.5L8 18"/></svg></span><span class="lbl">選擇照片</span></button>
        </div>
        <input id="cp-camera" type="file" accept="image/*" capture="environment" hidden />
        <input id="cp-file" type="file" accept="image/*" hidden />
        <div id="cp-preview" class="photo-preview" hidden>
          <img id="cp-img" alt="" />
          <div class="info">
            <div id="cp-meta"></div>
            <label class="inline small" id="cp-use-taken-wrap" hidden><input type="checkbox" id="cp-use-taken" /> 以拍攝時間 <span id="cp-taken-label"></span> 為打卡時間</label>
            <div class="row">
              <button id="cp-photo-submit" type="button" disabled>上傳並打卡</button>
              <button id="cp-photo-gps" type="button" class="secondary">改用目前定位</button>
            </div>
          </div>
        </div>
      </section>
      <section class="card fc-card"><h2>接下來 24 小時 <span class="muted">假設不再打卡</span></h2><div id="cp-forecast" class="forecast"></div></section>
      <section class="card map-card">
        <h2>位置 <span class="muted">藍點為目前位置，其餘為最近 5 次打卡</span></h2>
        <div id="cp-map" class="map small"></div>
        <p id="cp-map-note" class="muted small"></p>
      </section>
      <section class="timeline"><h2>最近 5 次打卡</h2><ul id="cp-timeline"></ul></section>
      <div id="share"></div>
      <footer class="foot"><small>此頁不需登入，持有連結者即可替這趟行程打卡，請勿轉傳。<br><button id="cp-refresh" class="link" type="button">重新整理</button></small></footer>
    </div>`;

  renderShareBar(root.querySelector<HTMLElement>('#share')!, `${location.origin}/c/${token}`, '在 LINE 內按「開啟」會用 Safari 開啟，再用「分享 → 加入主畫面」做成捷徑。');
  const statusEl = root.querySelector<HTMLElement>('#cp-status')!;
  const noteEl = root.querySelector<HTMLInputElement>('#cp-note')!;
  const nextEl = root.querySelector<HTMLInputElement>('#cp-next')!;
  const gpsBtn = root.querySelector<HTMLButtonElement>('#cp-gps')!;
  const cameraIn = root.querySelector<HTMLInputElement>('#cp-camera')!;
  const fileIn = root.querySelector<HTMLInputElement>('#cp-file')!;
  const preview = root.querySelector<HTMLElement>('#cp-preview')!;
  const img = root.querySelector<HTMLImageElement>('#cp-img')!;
  const metaEl = root.querySelector<HTMLElement>('#cp-meta')!;
  const photoSubmit = root.querySelector<HTMLButtonElement>('#cp-photo-submit')!;
  const useTakenWrap = root.querySelector<HTMLElement>('#cp-use-taken-wrap')!;
  const useTaken = root.querySelector<HTMLInputElement>('#cp-use-taken')!;
  const takenLabel = root.querySelector<HTMLElement>('#cp-taken-label')!;

  // ---- 地圖：最近 5 次打卡 + 目前位置 ----
  const map = createMap(root.querySelector<HTMLElement>('#cp-map')!);
  const track = new TrackLayer(map);
  const mapNote = root.querySelector<HTMLElement>('#cp-map-note')!;
  const tlEl = root.querySelector<HTMLElement>('#cp-timeline')!;
  let hereLayer: L.LayerGroup | null = null;
  let here: { lat: number; lng: number; acc: number | null } | null = null;
  let recentItems: RecentItem[] = [];
  const toRecentItem = (j: CheckinJson): RecentItem => ({
    id: j.id,
    lat: j.lat,
    lng: j.lng,
    acc: j.acc,
    src: j.src,
    tz: j.tz,
    place: j.place,
    note: j.note,
    photoId: null, // 打卡頁沒有家人頁 token，不顯示照片
    takenAt: j.takenAt ? Timestamp.fromDate(new Date(j.takenAt)) : null,
    at: Timestamp.fromDate(new Date(j.at)),
  });
  const fitMap = (): void => {
    const pts: L.LatLngExpression[] = recentItems.map((r) => [r.lat, r.lng] as L.LatLngExpression);
    if (here) pts.push([here.lat, here.lng]);
    if (!pts.length) return;
    if (pts.length === 1) map.setView(pts[0], 14);
    else map.fitBounds(L.latLngBounds(pts).pad(0.2), { maxZoom: 15 });
  };
  const drawHere = (): void => {
    hereLayer?.remove();
    hereLayer = null;
    if (!here) return;
    hereLayer = L.layerGroup().addTo(map);
    if (here.acc && here.acc > 0) L.circle([here.lat, here.lng], { radius: here.acc, color: '#1d4ed8', weight: 1, fillOpacity: 0.08 }).addTo(hereLayer);
    L.circleMarker([here.lat, here.lng], { radius: 8, color: '#fff', weight: 3, fillColor: '#2563eb', fillOpacity: 1 }).bindPopup('目前位置').addTo(hereLayer);
    mapNote.textContent = `目前位置 ${here.lat.toFixed(4)}, ${here.lng.toFixed(4)}${here.acc ? ` ±${Math.round(here.acc)} m` : ''}`;
  };
  const setHere = (pos: GeolocationPosition): void => {
    here = { lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy };
    drawHere();
    fitMap();
  };
  const drawRecent = (items: CheckinJson[]): void => {
    recentItems = items.slice(0, 5).map(toRecentItem);
    track.render(recentItems, { fit: false });
    renderTimeline(tlEl, recentItems, new Date());
    fitMap();
    window.setTimeout(() => map.invalidateSize(), 50);
  };
  const locateForMap = (): void => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(setHere, () => {
      if (!here) mapNote.textContent = '尚未取得目前位置（允許定位後會顯示）';
    }, { enableHighAccuracy: false, timeout: 8_000, maximumAge: 120_000 });
  };
  const photoGps = root.querySelector<HTMLButtonElement>('#cp-photo-gps')!;

  const setBusy = (busy: boolean): void => {
    root.querySelectorAll<HTMLButtonElement>('.action-grid button').forEach((b) => (b.disabled = busy));
  };

  const renderStatus = (): void => {
    if (!info) return;
    const now = new Date();
    const last = info.lastCheckinAt ? new Date(info.lastCheckinAt) : null;
    const deadline = info.effectiveDeadlineAt ? new Date(info.effectiveDeadlineAt) : info.nextDeadlineAt ? new Date(info.nextDeadlineAt) : null;
    const shiftNote = info.deadlineShift === 'sleep' ? '（睡眠時段順延）' : info.deadlineShift === 'flight' ? '（航段順延）' : '';
    const offline = info.offlineUntil ? new Date(info.offlineUntil) : null;
    const overdue = deadline ? deadline < now : false;
    const cls = info.status !== 'active' ? 'idle' : overdue ? 'bad' : 'ok';
    statusEl.className = `status ${cls}`;
    statusEl.innerHTML = `
      <div class="trip-title">${esc(info.title)} <span class="muted">每 ${info.intervalHours} 小時回報</span></div>
      <div class="head">${info.status !== 'active' ? '行程已結束' : last ? `最後回報：${esc(fmtAgo(last, now))}` : '尚未回報'}</div>
      ${last ? `<div class="last">${info.lastCheckinPlace ? `📍 ${esc(info.lastCheckinPlace)} · ` : ''}${esc(fmtBoth(last, info.travelerTz))}</div>` : ''}
      ${deadline ? `<div class="sub">下次期限 ${esc(fmtBoth(deadline, info.travelerTz))}${esc(shiftNote)}${overdue ? ' <b>已逾時</b>' : ''}</div>` : ''}
      ${offline && offline > now ? `<div class="sub">✈️ 預告離線至 ${esc(fmtBoth(offline, info.travelerTz))}</div>` : ''}`;
  };

  const renderError = (e: unknown): void => {
    statusEl.className = 'status bad';
    statusEl.innerHTML = `<div class="head">無法載入</div><div class="sub">${esc(errText(e))}</div>`;
    setBusy(true);
  };

  const load = async (): Promise<void> => {
    try {
      info = await api.checkinPage.get(token);
      applyPwaIdentity('checkin', info.title);
      renderStatus();
      setBusy(info.status !== 'active');
      drawRecent(info.recent ?? []);
      locateForMap();
      void api.checkinPage
        .forecast(token)
        .then((f) => renderForecast(root.querySelector<HTMLElement>('#cp-forecast')!, f))
        .catch(() => undefined);
    } catch (e) {
      renderError(e);
    }
  };

  const extras = () => ({
    note: noteEl.value.trim(),
    nextHours: nextEl.value ? Number(nextEl.value) : null,
    clientAt: new Date().toISOString(),
  });

  const clearPhoto = (): void => {
    if (img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
    img.removeAttribute('src');
    metaEl.textContent = '';
    photoSubmit.disabled = true;
    photoSubmit.textContent = '上傳並打卡';
    preview.hidden = true;
    photoState = null;
    useTaken.checked = false;
    useTakenWrap.hidden = true;
    cameraIn.value = '';
    fileIn.value = '';
  };

  const afterCheckin = (deadline: string, tz: string, what: string): void => {
    toast(`${what}，下次期限 ${fmtBoth(new Date(deadline), tz)}`);
    noteEl.value = '';
    nextEl.value = '';
    clearPhoto();
    if (navigator.vibrate) navigator.vibrate(30);
    void load();
  };

  gpsBtn.addEventListener('click', () => {
    setBusy(true);
    gpsBtn.querySelector('.lbl')!.textContent = '定位中…';
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        setHere(pos);
        try {
          const r = await api.checkinPage.checkin(token, {
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
            source: 'web-gps',
            ...extras(),
          });
          afterCheckin(r.nextDeadlineAt, r.tz, '已打卡');
        } catch (e) {
          toast(errText(e), 'err');
        } finally {
          gpsBtn.querySelector('.lbl')!.textContent = '定位打卡';
          setBusy(false);
        }
      },
      (err) => {
        gpsBtn.querySelector('.lbl')!.textContent = '定位打卡';
        setBusy(false);
        toast(`定位失敗（${err.message}）。請確認已允許定位，或改傳位置給 LINE 官方帳號。`, 'err');
      },
      { enableHighAccuracy: true, timeout: 12_000, maximumAge: 60_000 },
    );
  });

  const renderMeta = (): void => {
    if (!photoState) return;
    const p = photoState;
    const loc = p.lat != null && p.lng != null ? `📍 ${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}${p.accuracy ? ` ±${Math.round(p.accuracy)} m` : ''}` : '<span class="bad-text">沒有座標</span>';
    const taken = p.takenAt && info ? `拍攝於 ${fmtBoth(p.takenAt, info.travelerTz)}` : '無拍攝時間';
    metaEl.innerHTML = `<div>${loc}</div><div class="muted">${esc(taken)} · ${esc(fmtBytes(p.file.size))}</div>`;
    photoSubmit.disabled = !(p.lat != null && p.lng != null);
    // 拍攝時間在過去 7 天內、且不是剛拍的（差 2 分鐘以上）才提供「以拍攝時間為打卡時間」
    const ageMs = p.takenAt ? Date.now() - p.takenAt.getTime() : -1;
    const offer = p.takenAt != null && ageMs > 2 * 60_000 && ageMs < 7 * 86_400_000;
    useTakenWrap.hidden = !offer;
    if (offer && info) takenLabel.textContent = fmtBoth(p.takenAt!, info.travelerTz);
    if (!offer) useTaken.checked = false;
  };

  const fillFromGps = (): void => {
    photoGps.disabled = true;
    metaEl.innerHTML = `${metaEl.innerHTML}<div class="muted">定位中…</div>`;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (photoState) {
          photoState.lat = pos.coords.latitude;
          photoState.lng = pos.coords.longitude;
          photoState.accuracy = pos.coords.accuracy;
        }
        photoGps.disabled = false;
        renderMeta();
      },
      (err) => {
        photoGps.disabled = false;
        renderMeta();
        toast(`定位失敗（${err.message}）`, 'err');
      },
      { enableHighAccuracy: true, timeout: 12_000, maximumAge: 60_000 },
    );
  };

  const onPicked = async (input: HTMLInputElement, fromCamera: boolean): Promise<void> => {
    const file = input.files?.[0];
    if (!file) return;
    if (img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
    preview.hidden = false;
    img.src = URL.createObjectURL(file);
    metaEl.textContent = '讀取照片資訊…';
    const meta = await extractPhotoMeta(file);
    photoState = { file, ...meta };
    if (fromCamera && photoState.takenAt == null) photoState.takenAt = new Date();
    renderMeta();
    if (photoState.lat == null || photoState.lng == null) fillFromGps();
    input.value = '';
  };
  root.querySelector('#cp-take')!.addEventListener('click', () => cameraIn.click());
  root.querySelector('#cp-choose')!.addEventListener('click', () => fileIn.click());
  cameraIn.addEventListener('change', () => void onPicked(cameraIn, true));
  fileIn.addEventListener('change', () => void onPicked(fileIn, false));
  photoGps.addEventListener('click', fillFromGps);

  photoSubmit.addEventListener('click', async () => {
    if (!photoState || photoState.lat == null || photoState.lng == null) return;
    photoSubmit.disabled = true;
    photoSubmit.textContent = '上傳中…';
    try {
      const { blob, type } = await shrinkImage(photoState.file);
      const fd = new FormData();
      fd.append('lat', String(photoState.lat));
      fd.append('lng', String(photoState.lng));
      if (photoState.accuracy) fd.append('accuracy', String(photoState.accuracy));
      const x = extras();
      if (x.note) fd.append('note', x.note);
      if (x.nextHours) fd.append('nextHours', String(x.nextHours));
      if (photoState.takenAt) fd.append('takenAt', photoState.takenAt.toISOString());
      const backdate = useTaken.checked && !useTakenWrap.hidden && photoState.takenAt;
      if (backdate) fd.append('useTakenAt', '1');
      fd.append('clientAt', x.clientAt);
      fd.append('photo', blob, type === 'image/jpeg' ? 'photo.jpg' : photoState.file.name || 'photo');
      const r = await api.checkinPage.photo(token, fd);
      afterCheckin(r.nextDeadlineAt, r.tz, backdate ? `已用照片打卡（打卡時間 ${fmtBoth(photoState.takenAt!, r.tz)}）` : '已用照片打卡');
    } catch (e) {
      toast(errText(e), 'err');
    } finally {
      photoSubmit.disabled = false;
      photoSubmit.textContent = '上傳並打卡';
    }
  });

  root.querySelector('#cp-refresh')!.addEventListener('click', () => void load());
  const onVisible = (): void => {
    if (document.visibilityState === 'visible') void load();
  };
  document.addEventListener('visibilitychange', onVisible);
  timer = window.setInterval(() => {
    renderStatus();
    if (recentItems.length) renderTimeline(tlEl, recentItems, new Date());
  }, 30_000);
  void load();

  return () => {
    document.removeEventListener('visibilitychange', onVisible);
    if (timer) window.clearInterval(timer);
    map.remove();
  };
}
