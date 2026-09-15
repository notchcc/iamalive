/**
 * 家人頁 /w/{readToken}：雙時鐘、狀態、地圖、時間軸。onSnapshot 即時更新。
 */
import { Timestamp, doc, onSnapshot } from 'firebase/firestore';
import { firestore } from './firebase';
import { currentFlight, effectiveDeadline, toWindows } from './flights';
import { TrackLayer, createMap, placeText, renderTimeline, type TimelineOpts } from './mapview';
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
      <section class="gallery" id="gallery" hidden></section>
      <details class="flights" id="flights" hidden><summary><span class="ttl">航段</span><span class="muted" id="flights-sum"></span></summary><div id="flights-body"></div></details>
      <section class="map-wrap"><div id="map" class="map"></div></section>
      <section class="timeline"><h2>時間軸</h2><ul id="timeline"></ul><div id="tl-more" class="tl-more"></div></section>
      <footer class="foot"><small>此頁僅供持有連結者查看。位置由旅行者主動回報，非即時追蹤。</small></footer>
    </div>`;

  const clocksEl = root.querySelector<HTMLElement>('#clocks')!;
  const statusEl = root.querySelector<HTMLElement>('#status')!;
  const flightsEl = root.querySelector<HTMLElement>('#flights')!;
  const flightsBody = root.querySelector<HTMLElement>('#flights-body')!;
  const flightsSum = root.querySelector<HTMLElement>('#flights-sum')!;
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
  const toRecent = (j: { id: string; lat: number; lng: number; acc: number | null; src: RecentItem['src']; tz: string; place: string | null; note: string; photoId: string | null; takenAt: string | null; at: string }): RecentItem => ({
    id: j.id,
    lat: j.lat,
    lng: j.lng,
    acc: j.acc,
    src: j.src,
    tz: j.tz,
    place: j.place,
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
    statusEl.innerHTML = `
      <div class="trip-title">${esc(view.title)} <span class="muted">每 ${view.intervalHours} 小時回報</span></div>
      <div class="head">${esc(head)}</div>
      ${lastLine}
      <div class="sub">${esc(sub)}</div>`;
  };

  const renderFlights = (): void => {
    if (!view) return;
    const wins = toWindows(view.flights);
    if (!wins.length) {
      flightsEl.hidden = true;
      return;
    }
    const now = new Date();
    flightsEl.hidden = false;
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

  // ---- 最近照片幻燈片：先放 recent 前 10 張，往右滑到尾端再補（先用 recent 其餘，再向 API 續抓） ----
  const GALLERY_PAGE = 10;
  let galleryKey = '';
  let galleryIdx = 0;
  let galleryPausedUntil = 0;
  let galleryPhotos: RecentItem[] = [];
  let galleryCursor: string | null = null; // API 掃描游標（掃過的最舊一筆 at）
  let galleryExhausted = false;
  let galleryLoading = false;

  const slideHtml = (p: RecentItem, i: number): string => {
    const url = photoUrl(p.photoId!);
    return `<figure class="slide" data-i="${i}">
      <a href="${url}" target="_blank" rel="noopener"><img src="${url}" alt="" loading="${i < 2 ? 'eager' : 'lazy'}" /></a>
      <figcaption><span>${p.place ? esc(placeText(p)) : ''}</span><span class="when">${esc(fmtDateTime(p.at.toDate(), p.tz))}</span>${p.note ? `<span class="note">「${esc(p.note)}」</span>` : ''}</figcaption>
    </figure>`;
  };
  const renderCounter = (): void => {
    const c = galleryEl.querySelector<HTMLElement>('#gallery-counter');
    if (c) c.textContent = `${galleryIdx + 1} / ${galleryPhotos.length}${galleryExhausted ? '' : '+'}`;
  };
  const appendPhotos = (items: RecentItem[]): void => {
    const seen = new Set(galleryPhotos.map((p) => p.photoId));
    const fresh = items.filter((p) => p.photoId && !seen.has(p.photoId));
    if (!fresh.length) return;
    const slides = galleryEl.querySelector<HTMLElement>('#slides');
    if (!slides) return;
    const base = galleryPhotos.length;
    galleryPhotos = [...galleryPhotos, ...fresh];
    slides.insertAdjacentHTML('beforeend', fresh.map((p, k) => slideHtml(p, base + k)).join(''));
    renderCounter();
  };
  const loadMorePhotos = async (): Promise<void> => {
    if (!view || galleryLoading || galleryExhausted) return;
    // 1) recent 裡還沒放進來的
    const seen = new Set(galleryPhotos.map((p) => p.photoId));
    const fromRecent = view.recent.filter((r) => r.photoId && !seen.has(r.photoId)).slice(0, GALLERY_PAGE);
    if (fromRecent.length) {
      appendPhotos(fromRecent);
      return;
    }
    // 2) 比 recent 更舊的，向 API 續抓（游標從 recent 最後一筆開始）
    galleryLoading = true;
    try {
      const before = galleryCursor ?? view.recent[view.recent.length - 1]?.at.toDate().toISOString() ?? new Date().toISOString();
      const res = await fetch(`/api/w/${encodeURIComponent(token)}/checkins?photos=1&limit=${GALLERY_PAGE}&before=${encodeURIComponent(before)}`);
      if (!res.ok) {
        galleryExhausted = true;
        return;
      }
      const data = (await res.json()) as { items: Parameters<typeof toRecent>[0][]; cursor: string | null; exhausted: boolean };
      galleryCursor = data.cursor;
      galleryExhausted = data.exhausted;
      appendPhotos(data.items.map(toRecent));
    } catch {
      galleryExhausted = true;
    } finally {
      galleryLoading = false;
      renderCounter();
    }
  };

  const renderGallery = (): void => {
    if (!view) return;
    const head = view.recent.filter((r) => r.photoId).slice(0, GALLERY_PAGE);
    const key = head.map((p) => p.photoId).join(',');
    if (!head.length) {
      galleryEl.hidden = true;
      galleryKey = '';
      return;
    }
    galleryEl.hidden = false;
    if (key === galleryKey) return; // 只有最新 10 張變了才重建（新照片進來）
    galleryKey = key;
    galleryIdx = 0;
    galleryPhotos = head;
    galleryCursor = null;
    galleryExhausted = false;
    galleryEl.innerHTML = `
      <div class="slides" id="slides">${head.map(slideHtml).join('')}</div>
      <span class="counter" id="gallery-counter"></span>
      <a class="pc-link" href="/g/${encodeURIComponent(token)}">🖼 明信片模式</a>`;
    renderCounter();
    const slides = galleryEl.querySelector<HTMLElement>('#slides')!;
    slides.addEventListener(
      'scroll',
      () => {
        galleryPausedUntil = Date.now() + 10_000;
        const i = Math.round(slides.scrollLeft / slides.clientWidth);
        if (i !== galleryIdx) {
          galleryIdx = i;
          renderCounter();
        }
        // 快到尾端就補下一批
        if (i >= galleryPhotos.length - 2) void loadMorePhotos();
      },
      { passive: true },
    );
  };
  const galleryTimer = window.setInterval(() => {
    const slides = galleryEl.querySelector<HTMLElement>('#slides');
    if (!slides || galleryEl.hidden || document.visibilityState !== 'visible' || Date.now() < galleryPausedUntil) return;
    const n = slides.children.length;
    if (n < 2) return;
    const next = (galleryIdx + 1) % n;
    galleryIdx = next;
    slides.scrollTo({ left: next * slides.clientWidth, behavior: 'smooth' });
    renderCounter();
    // 自動輪播觸發的 scroll 事件不該算成使用者操作
    window.setTimeout(() => (galleryPausedUntil = 0), 800);
  }, 5000);

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
    window.clearInterval(galleryTimer);
    window.clearInterval(clockTimer);
    window.clearInterval(agoTimer);
    unsub();
    map.remove();
  };
}
