/**
 * 家人頁 /w/{readToken}：雙時鐘、狀態、地圖、時間軸。onSnapshot 即時更新。
 */
import { Timestamp, doc, onSnapshot } from 'firebase/firestore';
import { firestore } from './firebase';
import { currentFlight, effectiveDeadline, nextFlight, toWindows } from './flights';
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
      <section class="flights" id="flights" hidden></section>
      <section class="map-wrap"><div id="map" class="map"></div></section>
      <section class="timeline"><h2>時間軸</h2><ul id="timeline"></ul><div id="tl-more" class="tl-more"></div></section>
      <footer class="foot"><small>此頁僅供持有連結者查看。位置由旅行者主動回報，非即時追蹤。</small></footer>
    </div>`;

  const clocksEl = root.querySelector<HTMLElement>('#clocks')!;
  const statusEl = root.querySelector<HTMLElement>('#status')!;
  const flightsEl = root.querySelector<HTMLElement>('#flights')!;
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
    const deadline = effectiveDeadline(view.nextDeadlineAt.toDate(), wins);
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
      sub = overdue ? `已超過首次期限 ${fmtHours((now.getTime() - deadline.getTime()) / 3.6e6)}` : `首次期限 ${fmtBoth(deadline, view.travelerTz)}`;
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
      sub = `下次期限 ${fmtBoth(deadline, view.travelerTz)}`;
    }

    const lastLine = last
      ? `<div class="last">${lastItem ? `📍 ${esc(placeText(lastItem))} · ` : ''}${esc(fmtBoth(last, lastItem?.tz ?? view.travelerTz))}${lastItem?.note ? ` · 「${esc(lastItem.note)}」` : ''}</div>`
      : '';
    const nf = !inFlight && view.status === 'active' ? nextFlight(wins, now) : null;
    const nextLine = nf ? `<div class="sub muted">下一段 ${esc(nf.flightNo)} ${esc(nf.fromCity)} → ${esc(nf.toCity)}，${esc(fmtBoth(nf.departAt, nf.fromTz))} 起飛</div>` : '';

    statusEl.className = `status ${cls}`;
    statusEl.innerHTML = `
      <div class="trip-title">${esc(view.title)} <span class="muted">每 ${view.intervalHours} 小時回報</span></div>
      <div class="head">${esc(head)}</div>
      ${lastLine}
      <div class="sub">${esc(sub)}</div>${nextLine}`;
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
    flightsEl.innerHTML =
      '<h2>航段</h2><ul>' +
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

  const renderAll = (): void => {
    if (!view) return;
    renderClocks();
    renderStatus();
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
    window.clearInterval(clockTimer);
    window.clearInterval(agoTimer);
    unsub();
    map.remove();
  };
}
