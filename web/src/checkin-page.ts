/**
 * /c/{token}：免登入打卡頁。每個行程一個能力型 token，旅人把此頁加到 iPhone 主畫面當捷徑。
 * 只能看該行程摘要與打卡（定位 / 拍照 / 選照片），不能改行程。
 */
import { ApiError, api } from './api';
import { extractPhotoMeta, fmtBytes, shrinkImage } from './photo';
import { fmtAgo, fmtBoth } from './time';
import type { CheckinPageJson } from './types';
import { renderShareBar } from './share';
import { applyPwaIdentity } from './pwa';

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

const ERR: Record<string, string> = {
  TRIP_NOT_FOUND: '連結無效，請到管理頁重新取得打卡頁連結',
  TRIP_ENDED: '這趟行程已結束',
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
        <div class="big-actions">
          <button id="cp-gps" type="button">📍 定位打卡</button>
          <button id="cp-take" type="button" class="secondary">📷 拍照打卡</button>
          <button id="cp-choose" type="button" class="secondary">🖼️ 選擇照片</button>
        </div>
        <input id="cp-camera" type="file" accept="image/*" capture="environment" hidden />
        <input id="cp-file" type="file" accept="image/*" hidden />
        <div id="cp-preview" class="photo-preview" hidden>
          <img id="cp-img" alt="" />
          <div class="info">
            <div id="cp-meta"></div>
            <div class="row">
              <button id="cp-photo-submit" type="button" disabled>上傳並打卡</button>
              <button id="cp-photo-gps" type="button" class="secondary">改用目前定位</button>
            </div>
          </div>
        </div>
      </section>
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
  const photoGps = root.querySelector<HTMLButtonElement>('#cp-photo-gps')!;

  const setBusy = (busy: boolean): void => {
    root.querySelectorAll<HTMLButtonElement>('.big-actions button').forEach((b) => (b.disabled = busy));
  };

  const renderStatus = (): void => {
    if (!info) return;
    const now = new Date();
    const last = info.lastCheckinAt ? new Date(info.lastCheckinAt) : null;
    const deadline = info.nextDeadlineAt ? new Date(info.nextDeadlineAt) : null;
    const offline = info.offlineUntil ? new Date(info.offlineUntil) : null;
    const overdue = deadline ? deadline < now : false;
    const cls = info.status !== 'active' ? 'idle' : overdue ? 'bad' : 'ok';
    statusEl.className = `status ${cls}`;
    statusEl.innerHTML = `
      <div class="trip-title">${esc(info.title)} <span class="muted">每 ${info.intervalHours} 小時回報</span></div>
      <div class="head">${info.status !== 'active' ? '行程已結束' : last ? `最後回報：${esc(fmtAgo(last, now))}` : '尚未回報'}</div>
      ${last ? `<div class="last">${info.lastCheckinPlace ? `📍 ${esc(info.lastCheckinPlace)} · ` : ''}${esc(fmtBoth(last, info.travelerTz))}</div>` : ''}
      ${deadline ? `<div class="sub">下次期限 ${esc(fmtBoth(deadline, info.travelerTz))}${overdue ? ' <b>已逾時</b>' : ''}</div>` : ''}
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
    } catch (e) {
      renderError(e);
    }
  };

  const extras = () => ({
    note: noteEl.value.trim(),
    nextHours: nextEl.value ? Number(nextEl.value) : null,
    clientAt: new Date().toISOString(),
  });

  const afterCheckin = (deadline: string, tz: string, what: string): void => {
    toast(`${what}，下次期限 ${fmtBoth(new Date(deadline), tz)}`);
    noteEl.value = '';
    nextEl.value = '';
    preview.hidden = true;
    photoState = null;
    if (navigator.vibrate) navigator.vibrate(30);
    void load();
  };

  gpsBtn.addEventListener('click', () => {
    setBusy(true);
    gpsBtn.textContent = '定位中…';
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
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
          gpsBtn.textContent = '📍 定位打卡';
          setBusy(false);
        }
      },
      (err) => {
        gpsBtn.textContent = '📍 定位打卡';
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
      fd.append('clientAt', x.clientAt);
      fd.append('photo', blob, type === 'image/jpeg' ? 'photo.jpg' : photoState.file.name || 'photo');
      const r = await api.checkinPage.photo(token, fd);
      afterCheckin(r.nextDeadlineAt, r.tz, '已用照片打卡');
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
  timer = window.setInterval(renderStatus, 30_000);
  void load();

  return () => {
    document.removeEventListener('visibilitychange', onVisible);
    if (timer) window.clearInterval(timer);
  };
}
