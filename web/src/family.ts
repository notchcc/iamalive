/**
 * 家人頁 /w/{readToken}：雙時鐘、狀態、地圖、時間軸。onSnapshot 即時更新。
 */
import { doc, onSnapshot } from 'firebase/firestore';
import { firestore } from './firebase';
import { currentFlight, effectiveDeadline, nextFlight, toWindows } from './flights';
import { TrackLayer, createMap, placeText, renderTimeline } from './mapview';
import { TAIPEI, fmtAgo, fmtBoth, fmtClock, fmtDate, fmtDateTime, fmtHours, sameAsTaipei, tzLabel, utcOffset } from './time';
import type { View } from './types';

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

/** 城市名，若時區城市與輸入城市不同則附註時區城市，方便發現選錯時區。 */
function cityTz(city: string, tz: string): string {
  const label = tzLabel(tz);
  return label === city ? esc(city) : `${esc(city)} <small>(${esc(label)})</small>`;
}

export function renderFamilyPage(root: HTMLElement, token: string): () => void {
  root.innerHTML = `
    <div class="page family">
      <header class="clocks" id="clocks"></header>
      <section class="status" id="status"><p class="muted">載入中…</p></section>
      <section class="flights" id="flights" hidden></section>
      <section class="map-wrap"><div id="map" class="map"></div></section>
      <section class="timeline"><h2>時間軸</h2><ul id="timeline"></ul></section>
      <footer class="foot"><small>此頁僅供持有連結者查看。位置由旅行者主動回報，非即時追蹤。</small></footer>
    </div>`;

  const clocksEl = root.querySelector<HTMLElement>('#clocks')!;
  const statusEl = root.querySelector<HTMLElement>('#status')!;
  const flightsEl = root.querySelector<HTMLElement>('#flights')!;
  const timelineEl = root.querySelector<HTMLElement>('#timeline')!;
  const map = createMap(root.querySelector<HTMLElement>('#map')!);
  const track = new TrackLayer(map);

  let view: View | null = null;
  let firstFit = true;
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
    track.render(view.recent, { fit: firstFit, photoUrl });
    firstFit = false;
    renderTimeline(timelineEl, view.recent, new Date(), photoUrl);
    document.title = `${view.title} · iamalive`;
  };

  renderClocks();
  const clockTimer = window.setInterval(() => {
    renderClocks();
    renderStatus();
  }, 1000);
  const agoTimer = window.setInterval(() => {
    if (view) renderTimeline(timelineEl, view.recent, new Date(), photoUrl);
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
    window.clearInterval(clockTimer);
    window.clearInterval(agoTimer);
    unsub();
    map.remove();
  };
}
