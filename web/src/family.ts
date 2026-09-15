/**
 * 家人頁 /w/{readToken}：雙時鐘、狀態、照片幻燈片、地圖、時間軸。onSnapshot 即時更新。
 */
import { Timestamp, doc, onSnapshot } from 'firebase/firestore';
import L from 'leaflet';
import { firestore } from './firebase';
import { currentFlight, effectiveDeadline, toWindows } from './flights';
import { TrackLayer, createMap, placeText, renderTimeline, type TimelineOpts } from './mapview';
import { createPostcardDeck, type PostcardDeck, type PostcardPhoto } from './postcard';
import { renderShareBar } from './share';
import { applyPwaIdentity } from './pwa';
import { TAIPEI, fmtAgo, fmtBoth, fmtClock, fmtDate, fmtDateTime, fmtHours, sameAsTaipei, tzLabel, utcOffset } from './time';
import type { RecentItem, View } from './types';

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

function cityTz(city: string, _tz: string): string {
  return esc(city);
}

export function renderFamilyPage(root: HTMLElement, token: string, tlOpts: TimelineOpts = {}): () => void {
  root.innerHTML = `
    <div class="page family">
      <div id="share"></div>
      <header class="clocks" id="clocks"></header>
      <section class="status" id="status"><p class="muted">載入中…</p></section>
      <section class="gallery pc-embed" id="gallery" hidden></section>
      <section class="map-wrap"><div id="map" class="map"></div><button class="map-all" id="map-all" type="button" hidden>顯示全部打卡點</button></section>
      <section class="timeline"><h2>時間軸</h2><ul id="timeline"></ul><div id="tl-more" class="tl-more"></div></section>
      <footer class="foot"><small>此頁僅供持有連結者查看。位置由旅行者主動回報，非即時追蹤。</small></footer>
    </div>`;

  const clocksEl = root.querySelector<HTMLElement>('#clocks')!;
  const statusEl = root.querySelector<HTMLElement>('#status')!;
  // 狀態卡：主要內容每秒重繪；右上角兩顆 toggle 鈕（最後打卡地點 / 航段）與面板固定不重建（避免點擊時被換掉）
  const PLANE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/></svg>';
  const PIN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/></svg>';
  const mountStatus = (): void => {
    statusEl.innerHTML = `
      <div class="status-top">
      <div class="trip-title" id="status-title"></div>
      <div class="status-actions">
        <button class="card-toggle" id="last-toggle" type="button" hidden aria-expanded="false" aria-controls="last-panel" title="最後打卡與下次期限">${PIN}<span class="lbl" id="last-place"></span></button>
        <button class="card-toggle" id="flights-toggle" type="button" hidden aria-expanded="false" aria-controls="flights-panel" title="航段資訊">${PLANE}<span class="lbl" id="flights-count"></span></button>
      </div>
      </div>
      <div id="status-main"></div>
      <div class="card-panel" id="last-panel" hidden></div>
      <div class="card-panel flights-panel" id="flights-panel" hidden><div class="fsum" id="flights-sum"></div><div id="flights-body"></div></div>`;
  };
  mountStatus();
  const q = <T extends HTMLElement>(sel: string): T => root.querySelector<T>(sel)!;
  const statusMain = (): HTMLElement => q('#status-main');
  const lastToggle = q<HTMLButtonElement>('#last-toggle');
  const lastPlace = q('#last-place');
  const lastPanel = q('#last-panel');
  const flightsToggle = q<HTMLButtonElement>('#flights-toggle');
  const flightsCount = q('#flights-count');
  const flightsPanel = q('#flights-panel');
  const flightsBody = q('#flights-body');
  const flightsSum = q('#flights-sum');
  let lastOpen = false;
  let flightsOpen = false;
  const wireToggle = (btn: HTMLButtonElement, panel: HTMLElement, get: () => boolean, set: (v: boolean) => void): void => {
    btn.addEventListener('click', () => {
      set(!get());
      panel.hidden = !get();
      btn.setAttribute('aria-expanded', String(get()));
      btn.classList.toggle('on', get());
    });
  };
  wireToggle(lastToggle, lastPanel, () => lastOpen, (v) => (lastOpen = v));
  wireToggle(flightsToggle, flightsPanel, () => flightsOpen, (v) => (flightsOpen = v));
  const galleryEl = root.querySelector<HTMLElement>('#gallery')!;
  const timelineEl = root.querySelector<HTMLElement>('#timeline')!;
  applyPwaIdentity('family');
  renderShareBar(root.querySelector<HTMLElement>('#share')!, `${location.origin}/w/${token}`, '把這條連結傳給家人即可查看；在 LINE 內按「開啟」會用瀏覽器開啟。', { collapsed: true });
  const map = createMap(root.querySelector<HTMLElement>('#map')!);
  const track = new TrackLayer(map);

  let view: View | null = null;
  let firstFit = true;

  // ---- 時間軸分頁：先顯示 10 筆，捲到底再加 10 筆；view.recent（最多 100 筆，即時）用完後改向 API 取更舊的 ----
  const PAGE = 10;
  let shownCount = PAGE;
  let extra: RecentItem[] = []; // 比 view.recent 最後一筆更舊的紀錄（API 取得）
  let exhausted = false;
  let loadingMore = false;
  const moreEl = root.querySelector<HTMLElement>('#tl-more')!;
  const fullList = (): RecentItem[] => {
    if (!view) return [];
    const seen = new Set(view.recent.map((r) => r.id));
    return [...view.recent, ...extra.filter((e) => !seen.has(e.id))];
  };
  let trackKey = '';
  const renderTl = (): void => {
    if (!view) return;
    const all = fullList();
    const shown = all.slice(0, shownCount);
    renderTimeline(timelineEl, shown, new Date(), photoUrl, tlOpts);
    // 地圖只畫時間軸已載入的點；資料沒變就不重畫（每分鐘的「多久前」更新不動地圖）
    const key = shown.map((s) => s.id ?? s.at.toMillis()).join(',');
    if (key !== trackKey) {
      trackKey = key;
      track.render(shown, { fit: firstFit, photoUrl });
      firstFit = false;
    }
    const hasMore = shownCount < all.length || !exhausted;
    moreEl.textContent = loadingMore ? '載入中…' : hasMore ? '' : all.length > PAGE ? '已顯示全部' : '';
    moreEl.hidden = !hasMore && all.length <= PAGE;
  };
  const toRecent = (j: { id: string; lat: number; lng: number; acc: number | null; src: RecentItem['src']; tz: string; place: string | null; placeEn?: string | null; note: string; photoId: string | null; takenAt: string | null; at: string }): RecentItem => ({
    id: j.id,
    lat: j.lat,
    lng: j.lng,
    acc: j.acc,
    src: j.src,
    tz: j.tz,
    place: j.place,
    placeEn: j.placeEn ?? null,
    note: j.note,
    photoId: j.photoId,
    takenAt: j.takenAt ? Timestamp.fromDate(new Date(j.takenAt)) : null,
    at: Timestamp.fromDate(new Date(j.at)),
  });
  const loadMore = async (): Promise<void> => {
    if (!view || loadingMore) return;
    const all = fullList();
    if (shownCount < all.length) {
      shownCount = Math.min(shownCount + PAGE, all.length);
      renderTl();
      return;
    }
    if (exhausted) return;
    const last = all[all.length - 1];
    loadingMore = true;
    renderTl();
    try {
      const res = await fetch(`/api/w/${encodeURIComponent(token)}/checkins?limit=${PAGE}${last ? `&before=${encodeURIComponent(last.at.toDate().toISOString())}` : ''}`);
      const rows = res.ok ? ((await res.json()) as Parameters<typeof toRecent>[0][]) : [];
      if (rows.length < PAGE) exhausted = true;
      extra = [...extra, ...rows.map(toRecent)];
      shownCount += rows.length;
    } catch {
      exhausted = true;
    } finally {
      loadingMore = false;
      renderTl();
    }
  };
  const io = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) void loadMore();
  });
  io.observe(moreEl);
  const photoUrl = (id: string): string => `/api/p/${encodeURIComponent(token)}/${encodeURIComponent(id)}`;

  const renderClocks = (): void => {
    const now = new Date();
    const tz = view?.travelerTz ?? TAIPEI;
    const same = sameAsTaipei(now, tz);
    const tpe = `<div class="clock"><div class="clock-label">台北 <span class="off">${utcOffset(now, TAIPEI)}</span></div>
      <div class="clock-time">${fmtClock(now, TAIPEI)}</div><div class="clock-date">${fmtDate(now, TAIPEI)}</div></div>`;
    const local = same
      ? `<div class="clock same"><div class="clock-label">旅人所在</div><div class="clock-note">與台北同時區</div></div>`
      : `<div class="clock"><div class="clock-label">${esc(tzLabel(tz))} <span class="off">${utcOffset(now, tz)}</span></div>
      <div class="clock-time">${fmtClock(now, tz)}</div><div class="clock-date">${fmtDate(now, tz)}</div></div>`;
    clocksEl.innerHTML = tpe + local;
  };

  const renderStatus = (): void => {
    if (!view) return;
    const now = new Date();
    const last = view.lastCheckinAt ? view.lastCheckinAt.toDate() : null;
    const wins = toWindows(view.flights);
    const deadline = view.effectiveDeadlineAt ? view.effectiveDeadlineAt.toDate() : effectiveDeadline(view.nextDeadlineAt.toDate(), wins);
    const shiftNote = view.deadlineShift === 'sleep' ? '（睡眠時段順延）' : view.deadlineShift === 'flight' ? '（航段順延）' : '';
    const offlineUntil = view.offlineUntil ? view.offlineUntil.toDate() : null;
    const inFlight = view.status === 'active' ? currentFlight(wins, now) : null;
    const overdue = view.status === 'active' && deadline < now && !(offlineUntil && offlineUntil > now) && !inFlight;
    const lastItem = view.recent[0];

    let cls = 'ok';
    let head = '';
    let sub = '';
    if (view.status === 'active' && inFlight) {
      cls = 'inflight';
      head = `✈️ 飛行中 ${inFlight.flightNo}`;
      sub = `${inFlight.fromCity} → ${inFlight.toCity}，預計 ${fmtBoth(inFlight.arriveAt, inFlight.toTz)} 降落，落地後 3 小時內回報`;
    } else if (view.status === 'completed') {
      cls = 'done';
      head = '行程已結束';
      sub = last ? `最後回報 ${fmtBoth(last, lastItem?.tz ?? view.travelerTz)}` : '';
    } else if (!last) {
      cls = overdue ? 'bad' : 'idle';
      head = '尚未回報';
      sub = overdue ? `已超過首次期限 ${fmtHours((now.getTime() - deadline.getTime()) / 3.6e6)}` : `首次期限 ${fmtBoth(deadline, view.travelerTz)}${shiftNote}`;
    } else if (offlineUntil && offlineUntil > now) {
      cls = 'offline';
      head = `最後回報：${fmtAgo(last, now)}`;
      sub = `✈️ 預告離線至 ${fmtBoth(offlineUntil, view.travelerTz)}，期間不會警報`;
    } else if (overdue) {
      cls = 'bad';
      head = `最後回報：${fmtAgo(last, now)}`;
      sub = `⚠️ 已超過預定回報時間 ${fmtHours((now.getTime() - deadline.getTime()) / 3.6e6)}`;
    } else {
      cls = 'ok';
      head = `最後回報：${fmtAgo(last, now)}`;
      sub = `下次期限 ${fmtBoth(deadline, view.travelerTz)}${shiftNote}`;
    }

    const lastLine = last
      ? `<div class="last">${lastItem ? `📍 ${esc(placeText(lastItem))} · ` : ''}${esc(fmtBoth(last, lastItem?.tz ?? view.travelerTz))}${lastItem?.note ? ` · 「${esc(lastItem.note)}」` : ''}</div>`
      : '';

    statusEl.className = `status ${cls}`;
    if (!root.querySelector('#status-main')) mountStatus(); // 失效 / 錯誤訊息曾把卡片整個換掉
    // 有打卡紀錄時，最後打卡地點 / 時間與下次期限縮進右上角「📍 地點」鈕的面板；
    // 主區只留標題、狀態大字，以及警示類副標（超時 / 離線 / 飛行中 / 已結束）。
    const collapsed = !!last;
    const showSub = !collapsed || cls !== 'ok';
    q('#status-title').innerHTML = `${esc(view.title)} <span class="muted">每 ${view.intervalHours} 小時回報</span>`;
    statusMain().innerHTML = `
      <div class="head">${esc(head)}</div>
      ${collapsed ? '' : lastLine}
      ${showSub && sub ? `<div class="sub">${esc(sub)}</div>` : ''}`;
    lastToggle.hidden = !collapsed;
    if (collapsed) {
      const placeShort = (lastItem ? placeText(lastItem) : tzLabel(view.travelerTz)).split(',')[0].trim();
      if (lastPlace.textContent !== placeShort) lastPlace.textContent = placeShort;
      // 面板：兩列「標籤 / 內容」，不用圖示；順延原因做成小標籤
      const lastTz = lastItem?.tz ?? view.travelerTz;
      const shiftTag = view.deadlineShift === 'sleep' ? '睡眠時段順延' : view.deadlineShift === 'flight' ? '航段順延' : '';
      const rows = [
        `<div class="k">最後打卡</div><div class="v">${lastItem ? `<div>${esc(placeText(lastItem))}</div>` : ''}<div class="muted">${esc(fmtBoth(last, lastTz))}</div>${lastItem?.note ? `<div class="note">「${esc(lastItem.note)}」</div>` : ''}</div>`,
      ];
      if (view.status === 'active') {
        rows.push(
          `<div class="k">${deadline > now ? '下次期限' : '預定回報'}</div><div class="v"><div>${esc(fmtBoth(deadline, view.travelerTz))}${shiftTag ? ` <span class="tag">${shiftTag}</span>` : ''}</div></div>`,
        );
      }
      lastPanel.innerHTML = `<div class="kv">${rows.join('')}</div>`;
      lastPanel.hidden = !lastOpen;
    } else {
      lastPanel.hidden = true;
    }
  };

  const renderFlights = (): void => {
    if (!view) return;
    const wins = toWindows(view.flights);
    if (!wins.length) {
      flightsToggle.hidden = true;
      flightsPanel.hidden = true;
      return;
    }
    const now = new Date();
    flightsToggle.hidden = false;
    flightsPanel.hidden = !flightsOpen;
    flightsCount.textContent = `${wins.length} 段`;
    const nowF = currentFlight(wins, now);
    const upcoming = wins.filter((f) => f.departAt > now).sort((a, b) => a.departAt.getTime() - b.departAt.getTime())[0];
    flightsSum.textContent = nowF
      ? `${wins.length} 段 · 飛行中 ${nowF.flightNo}`
      : upcoming
        ? `${wins.length} 段 · 下一段 ${upcoming.flightNo} ${fmtDateTime(upcoming.departAt, upcoming.fromTz)}`
        : `${wins.length} 段 · 全部已降落`;
    flightsBody.innerHTML =
      '<ul>' +
      wins
        .map((f) => {
          const state = now > f.arriveAt ? 'done' : currentFlight([f], now) ? 'now' : 'todo';
          const label = state === 'done' ? '已降落' : state === 'now' ? '飛行中' : '未起飛';
          return `<li class="flight ${state}"><span class="fno">${esc(f.flightNo)}</span>
            <span class="leg">${cityTz(f.fromCity, f.fromTz)} ${esc(fmtDateTime(f.departAt, f.fromTz))} → ${cityTz(f.toCity, f.toTz)} ${esc(fmtDateTime(f.arriveAt, f.toTz))}</span>
            <span class="fstate">${label}</span></li>`;
        })
        .join('') +
      '</ul><p class="muted small">時間為各地當地時間；飛行中不會發出警報，落地後 3 小時內需回報。</p>';
  };

  // ---- 地圖：預設框住已載入的打卡點；幻燈片換張（含自動輪播）時飛到該張照片的拍攝地 ----
  const mapAllBtn = root.querySelector<HTMLButtonElement>('#map-all')!;
  const mapEl = root.querySelector<HTMLElement>('#map')!;
  const focusMarker = L.circleMarker([0, 0], { radius: 10, color: '#fff', weight: 3, fillColor: '#b8412f', fillOpacity: 1 });
  const focusHalo = L.circle([0, 0], { radius: 1500, color: '#b8412f', weight: 1, fillOpacity: 0.08 });
  let mapUserUntil = 0; // 使用者剛拖過地圖，20 秒內自動輪播不搶走視角
  const noteMapUse = (): void => {
    mapUserUntil = Date.now() + 20_000;
  };
  mapEl.addEventListener('pointerdown', noteMapUse, { passive: true });
  mapEl.addEventListener('wheel', noteMapUse, { passive: true });
  const focusPhoto = (p: PostcardPhoto, manual: boolean): void => {
    if (!manual && Date.now() < mapUserUntil) return;
    const ll: L.LatLngExpression = [p.lat, p.lng];
    focusMarker.setLatLng(ll).addTo(map);
    focusHalo.setLatLng(ll).addTo(map);
    focusMarker.unbindTooltip();
    if (p.place) focusMarker.bindTooltip(p.place, { direction: 'top' });
    map.flyTo(ll, Math.max(map.getZoom(), 10), { duration: 1.2 });
    mapAllBtn.hidden = false;
  };
  const showAllPoints = (): void => {
    focusMarker.remove();
    focusHalo.remove();
    mapAllBtn.hidden = true;
    track.fit();
    noteMapUse();
  };
  mapAllBtn.addEventListener('click', showAllPoints);

  // ---- 照片幻燈片（隨機）：recent 內有照片的先進牌堆，其餘向 API 續抓（每頁 50，最多 200 張），隨機輪播 ----
  let deck: PostcardDeck | null = null;
  let pcCursor: string | null = null; // API 掃描游標（掃過的最舊一筆 at）
  let pcExhausted = false;
  let pcLoading = false;
  const toPhoto = (r: RecentItem): PostcardPhoto | null =>
    r.photoId
      ? {
          photoId: r.photoId,
          lat: r.lat,
          lng: r.lng,
          tz: r.tz,
          place: r.place ?? null,
          placeEn: r.placeEn ?? null,
          note: r.note,
          takenAt: r.takenAt ? r.takenAt.toDate().toISOString() : null,
          at: r.at.toDate().toISOString(),
        }
      : null;
  const photosOf = (items: RecentItem[]): PostcardPhoto[] => items.map(toPhoto).filter((x): x is PostcardPhoto => !!x);
  const loadMorePhotos = async (): Promise<void> => {
    if (!view || !deck || pcLoading || pcExhausted || deck.count() >= 200) return;
    pcLoading = true;
    try {
      const before = pcCursor ?? view.recent[view.recent.length - 1]?.at.toDate().toISOString() ?? new Date().toISOString();
      const res = await fetch(`/api/w/${encodeURIComponent(token)}/checkins?photos=1&limit=50&before=${encodeURIComponent(before)}`);
      if (!res.ok) {
        pcExhausted = true;
        return;
      }
      const data = (await res.json()) as { items: Parameters<typeof toRecent>[0][]; cursor: string | null; exhausted: boolean };
      pcCursor = data.cursor;
      pcExhausted = data.exhausted || !data.cursor;
      deck.addPhotos(photosOf(data.items.map(toRecent)));
    } catch {
      pcExhausted = true;
    } finally {
      pcLoading = false;
    }
  };
  const renderGallery = (): void => {
    if (!view) return;
    const items = photosOf(view.recent);
    if (!items.length && !deck) {
      galleryEl.hidden = true;
      return;
    }
    galleryEl.hidden = false;
    if (!deck) {
      deck = createPostcardDeck(galleryEl, { photoUrl, onChange: focusPhoto, onNeedMore: () => void loadMorePhotos() });
      deck.addPhotos(items);
      void loadMorePhotos();
    } else {
      deck.addPhotos(items, { front: true }); // 新照片進來就排在下一張
    }
  };

  const renderAll = (): void => {
    if (!view) return;
    renderClocks();
    renderStatus();
    renderGallery();
    renderFlights();
    renderTl();
    applyPwaIdentity('family', view.title);
  };

  renderClocks();
  const clockTimer = window.setInterval(() => {
    renderClocks();
    renderStatus();
  }, 1000);
  const agoTimer = window.setInterval(() => {
    renderTl();
  }, 60_000);

  const unsub = onSnapshot(
    doc(firestore(), 'views', token),
    (snap) => {
      if (!snap.exists()) {
        view = null;
        statusEl.className = 'status bad';
        statusEl.innerHTML = '<div class="head">連結已失效</div><div class="sub">請向旅行者索取新的連結。</div>';
        timelineEl.innerHTML = '';
        return;
      }
      view = snap.data() as View;
      renderAll();
    },
    (err) => {
      statusEl.className = 'status bad';
      statusEl.innerHTML = `<div class="head">無法載入</div><div class="sub">${esc(String(err.message ?? err))}</div>`;
    },
  );

  return () => {
    io.disconnect();
    deck?.destroy();
    window.clearInterval(clockTimer);
    window.clearInterval(agoTimer);
    unsub();
    map.remove();
  };
}
