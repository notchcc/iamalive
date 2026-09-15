/**
 * /g/{readToken}：明信片展示頁。隨機輪播這趟旅程的打卡照片，標注拍攝地點與當地日期。
 * 權限同家人頁（同一個 readToken，照片經 /api/p/{token}/{id}）。
 */
import L from 'leaflet';
import { applyPwaIdentity } from './pwa';
import { tileLayer } from './mapview';

interface PhotoJson {
  id: string;
  lat: number;
  lng: number;
  tz: string;
  place: string | null;
  placeEn?: string | null;
  note: string;
  photoId: string | null;
  takenAt: string | null;
  at: string;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

function ensureFonts(): void {
  if (document.getElementById('pc-fonts')) return;
  const l = document.createElement('link');
  l.id = 'pc-fonts';
  l.rel = 'stylesheet';
  l.href = 'https://fonts.googleapis.com/css2?family=Caveat:wght@500;700&family=Noto+Serif+TC:wght@500;700&display=swap';
  document.head.appendChild(l);
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function localDate(iso: string, tz: string): { date: string; time: string; short: string } {
  const d = new Date(iso);
  const date = new Intl.DateTimeFormat('zh-TW', { timeZone: tz, year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' }).format(d);
  const time = new Intl.DateTimeFormat('zh-TW', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
  const short = new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: '2-digit', month: 'short', year: 'numeric' }).format(d).toUpperCase();
  return { date, time, short };
}

export type MarkStyle = 'a' | 'b' | 'c' | 'd' | 'e';

/** 城市 / 國家（英文優先）：placeEn 城市 → placeEn 只有國名 → 中文 place → 座標。 */
export function resolveLabel(p: PhotoJson): { city: string; country: string; short: string; long: string } {
  const ld = localDate(p.takenAt ?? p.at, p.tz);
  const split = (v: string | null | undefined): [string, string] => {
    if (!v) return ['', ''];
    const parts = v.split(',').map((x) => x.trim()).filter(Boolean);
    return parts.length > 1 ? [parts[0], parts.slice(1).join(', ')] : ['', parts[0] ?? ''];
  };
  const [cityEn, countryEn] = split(p.placeEn);
  const [cityZh, countryZh] = split(p.place);
  const city = cityEn || countryEn || cityZh || countryZh || `${p.lat.toFixed(2)}°, ${p.lng.toFixed(2)}°`;
  const country = (cityEn ? countryEn : '') || (cityZh && !cityEn ? countryZh : '');
  return { city: city.toUpperCase(), country: country.toUpperCase(), short: ld.short, long: `${ld.date} · ${ld.time}` };
}

/** 一張明信片的 HTML（照片 + 五種標示樣式擇一），供頁面與樣式預覽共用。 */
export function postcardMarkup(p: PhotoJson, opts: { photoUrl: (id: string) => string; mark: MarkStyle; rot: number }): string {
  const lb = resolveLabel(p);
  const src = opts.photoUrl(p.photoId!);
  const sub = lb.country ? `${lb.country} · ${lb.short}` : lb.short;
  let markHtml = '';
  switch (opts.mark) {
    case 'a': // 無郵戳：左下大字地名 + 小字國家與日期，底部漸層
      markHtml = `<div class="pc-shade"></div><div class="pc-mark"><div class="mk-city">${esc(lb.city)}</div><div class="mk-sub">${esc(sub)}</div></div>`;
      break;
    case 'b': {
      // 圓形郵戳：城市沿上弧排列，中央日期，下弧國家
      const arcLen = 125;
      const cityLen = Math.min(arcLen - 10, lb.city.length * 8.2);
      const tl = lb.city.length * 8.2 > arcLen - 10 ? ` textLength="${arcLen - 10}" lengthAdjust="spacingAndGlyphs"` : '';
      void cityLen;
      markHtml = `<svg class="pc-mark pc-round" viewBox="0 0 120 120" aria-hidden="true">
        <defs><path id="arcTop" d="M 20,60 a 40,40 0 1,1 80,0"/><path id="arcBot" d="M 14,60 a 46,46 0 0,0 92,0"/></defs>
        <circle cx="60" cy="60" r="56" fill="rgba(0,0,0,0.28)" stroke="rgba(255,255,255,0.95)" stroke-width="2.5"/>
        <circle cx="60" cy="60" r="34" fill="none" stroke="rgba(255,255,255,0.8)" stroke-width="1.2" stroke-dasharray="3 3"/>
        <text font-size="11" font-weight="700" letter-spacing="1.5" fill="#fff"><textPath href="#arcTop" startOffset="50%" text-anchor="middle"${tl}>${esc(lb.city)}</textPath></text>
        ${lb.country ? `<text font-size="7.5" letter-spacing="1" fill="rgba(255,255,255,0.9)"><textPath href="#arcBot" startOffset="50%" text-anchor="middle">${esc(lb.country)}</textPath></text>` : ''}
        <text x="60" y="57" text-anchor="middle" font-size="9.5" font-weight="700" fill="#fff">${esc(lb.short.slice(0, 6))}</text>
        <text x="60" y="70" text-anchor="middle" font-size="9.5" fill="#fff">${esc(lb.short.slice(-4))}</text>
        <line x1="8" y1="60" x2="20" y2="60" stroke="rgba(255,255,255,0.8)"/><line x1="100" y1="60" x2="112" y2="60" stroke="rgba(255,255,255,0.8)"/>
      </svg>`;
      break;
    }
    case 'c': // 行李吊牌：白色標籤、打孔、深色字
      markHtml = `<div class="pc-mark pc-tag"><i class="hole"></i><div class="mk-city">${esc(lb.city)}</div><div class="mk-sub">${esc(sub)}</div></div>`;
      break;
    case 'd': // 底部資訊條：圖釘 + 地名，右側日期
      markHtml = `<div class="pc-mark pc-strip"><span class="pin">📍</span><span class="mk-city">${esc(lb.city)}</span>${lb.country ? `<span class="mk-country">${esc(lb.country)}</span>` : ''}<span class="mk-date">${esc(lb.short)}</span></div>`;
      break;
    case 'e': // 郵票：右上角齒孔郵票，青綠色墨
      markHtml = `<div class="pc-mark pc-stampmark"><div class="inner"><div class="mk-city">${esc(lb.city)}</div><div class="mk-sub">${esc(sub)}</div></div></div>`;
      break;
  }
  return `
      <article class="postcard mark-${opts.mark}" style="--rot:${opts.rot}deg">
        <div class="pc-photo"><img src="${src}" alt="" title="${esc(p.place ?? '')}" />${markHtml}</div>
      </article>`;
}

export function renderPostcardsPage(root: HTMLElement, token: string): () => void {
  ensureFonts();
  applyPwaIdentity('family');
  const prevBg = document.documentElement.style.background;
  document.documentElement.style.background = '#1f2a33'; // 捲動彈跳時不露白
  document.title = '明信片 · iamalive';
  root.innerHTML = `
    <div class="pc-stage">
      <header class="pc-head">
        <a class="pc-back" href="/w/${encodeURIComponent(token)}">‹ 家人頁</a>
        <span class="pc-title" id="pc-title"></span>
        <span class="pc-actions">
          <a class="pc-dl" id="pc-dl" href="#" download aria-label="下載這張照片" title="下載這張照片" hidden><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg></a>
          <button class="pc-pause" id="pc-pause" type="button" aria-label="暫停">❚❚</button>
        </span>
      </header>
      <div class="pc-deck" id="pc-deck"><p class="pc-empty">載入中…</p></div>
      <div class="pc-mapwrap"><div id="pc-map" class="pc-mapbig"></div></div>
    </div>`;
  const deck = root.querySelector<HTMLElement>('#pc-deck')!;
  const titleEl = root.querySelector<HTMLElement>('#pc-title')!;
  const pauseBtn = root.querySelector<HTMLButtonElement>('#pc-pause')!;
  const dlEl = root.querySelector<HTMLAnchorElement>('#pc-dl')!;
  const photoUrl = (id: string): string => `/api/p/${encodeURIComponent(token)}/${encodeURIComponent(id)}`;

  let title = '';
  let photos: PhotoJson[] = [];
  let order: PhotoJson[] = [];
  let pos = -1;
  let paused = false;
  let timer: number | null = null;
  const INTERVAL = 7000;

  const mark = ((new URLSearchParams(location.search).get('mark') ?? 'a').toLowerCase().match(/^[a-e]$/)?.[0] ?? 'a') as MarkStyle;
  const cardHtml = (p: PhotoJson, rot: number): string => postcardMarkup(p, { photoUrl, mark, rot });

  // 下方獨立、可互動的地圖：換卡時飛到該張照片的拍攝地點
  const map = L.map(root.querySelector<HTMLElement>('#pc-map')!, { zoomControl: true, attributionControl: false });
  tileLayer().addTo(map);
  map.setView([25.04, 121.56], 3);
  const marker = L.circleMarker([0, 0], { radius: 9, color: '#fff', weight: 3, fillColor: '#b8412f', fillOpacity: 1 }).addTo(map);
  const halo = L.circle([0, 0], { radius: 1500, color: '#b8412f', weight: 1, fillOpacity: 0.08 }).addTo(map);
  let mapReady = false;
  const focusMap = (p: PhotoJson): void => {
    const ll: L.LatLngExpression = [p.lat, p.lng];
    marker.setLatLng(ll);
    halo.setLatLng(ll);
    marker.bindTooltip(p.place ?? '', { permanent: false, direction: 'top' });
    if (!mapReady) {
      map.setView(ll, 11);
      mapReady = true;
    } else {
      map.flyTo(ll, Math.max(map.getZoom(), 9), { duration: 1.2 });
    }
  };
  window.setTimeout(() => map.invalidateSize(), 60);

  const preload = (p: PhotoJson | undefined): void => {
    if (p?.photoId) new Image().src = photoUrl(p.photoId);
  };

  const nextItem = (): PhotoJson | null => {
    if (!photos.length) return null;
    pos++;
    if (pos >= order.length) {
      const last = order[order.length - 1];
      let next = shuffle(photos);
      if (next.length > 1 && next[0] === last) next = [...next.slice(1), next[0]];
      order = [...order, ...next];
    }
    return order[pos];
  };

  const show = (p: PhotoJson, dir: 1 | -1): void => {
    const prev = deck.querySelector<HTMLElement>('.postcard:not(.leave)');
    const rot = (Math.random() * 6 - 3).toFixed(1);
    deck.insertAdjacentHTML('beforeend', cardHtml(p, Number(rot)));
    const card = deck.lastElementChild as HTMLElement;
    card.classList.add(dir === 1 ? 'enter-right' : 'enter-left');
    requestAnimationFrame(() => card.classList.add('in'));
    focusMap(p);
    dlEl.hidden = false;
    dlEl.href = photoUrl(p.photoId!);
    dlEl.setAttribute('download', `${(p.placeEn ?? p.place ?? 'photo').split(',')[0].trim().replace(/\s+/g, '_')}_${(p.takenAt ?? p.at).slice(0, 10)}.jpg`);
    if (prev) {
      prev.classList.add('leave', dir === 1 ? 'leave-left' : 'leave-right');
      window.setTimeout(() => prev.remove(), 700);
    }
    deck.querySelector('.pc-empty')?.remove();
    preload(order[pos + 1]);
  };

  const next = (): void => {
    const p = nextItem();
    if (p) show(p, 1);
    restart();
  };
  const back = (): void => {
    if (pos <= 0) return;
    pos--;
    show(order[pos], -1);
    restart();
  };
  const restart = (): void => {
    if (timer) window.clearInterval(timer);
    timer = window.setInterval(() => {
      if (!paused && document.visibilityState === 'visible') next();
    }, INTERVAL);
  };

  pauseBtn.addEventListener('click', () => {
    paused = !paused;
    pauseBtn.textContent = paused ? '▶' : '❚❚';
    pauseBtn.setAttribute('aria-label', paused ? '播放' : '暫停');
  });
  deck.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('a')) return;
    next();
  });
  let tx = 0;
  deck.addEventListener('touchstart', (e) => (tx = e.touches[0].clientX), { passive: true });
  deck.addEventListener(
    'touchend',
    (e) => {
      const dx = e.changedTouches[0].clientX - tx;
      if (dx < -40) next();
      else if (dx > 40) back();
    },
    { passive: true },
  );
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'ArrowRight' || e.key === ' ') next();
    else if (e.key === 'ArrowLeft') back();
  };
  document.addEventListener('keydown', onKey);

  const load = async (): Promise<void> => {
    try {
      const summary = await fetch(`/api/w/${encodeURIComponent(token)}?limit=1`);
      if (summary.status === 404) throw new Error('連結無效');
      const sj = (await summary.json()) as { trip: { title: string } };
      title = sj.trip.title;
      titleEl.textContent = title;
      document.title = `${title} · 明信片`;
      // 收集有照片的打卡（最多 200 張）
      let before: string | null = null;
      for (let i = 0; i < 8; i++) {
        const res = await fetch(`/api/w/${encodeURIComponent(token)}/checkins?photos=1&limit=50${before ? `&before=${encodeURIComponent(before)}` : ''}`);
        if (!res.ok) break;
        const data = (await res.json()) as { items: PhotoJson[]; cursor: string | null; exhausted: boolean };
        photos.push(...data.items.filter((x) => x.photoId));
        before = data.cursor;
        if (data.exhausted || !before || photos.length >= 200) break;
      }
      if (!photos.length) {
        deck.innerHTML = '<p class="pc-empty">這趟旅程還沒有照片。<br><small>用照片打卡後，這裡會出現明信片。</small></p>';
        return;
      }
      order = shuffle(photos);
      pos = -1;
      next();
    } catch (e) {
      deck.innerHTML = `<p class="pc-empty">${esc(String((e as Error).message ?? e))}</p>`;
    }
  };
  void load();

  return () => {
    if (timer) window.clearInterval(timer);
    document.removeEventListener('keydown', onKey);
    document.documentElement.style.background = prevBg;
    map.remove();
  };
}
