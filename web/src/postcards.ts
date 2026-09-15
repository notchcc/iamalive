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
  l.href = 'https://fonts.googleapis.com/css2?family=Noto+Serif+TC:wght@500;700&display=swap';
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

/** 地名一律英文：placeEn 的城市；沒有城市就用國名；完全沒有就留空只顯示日期。 */
export function resolveLabel(p: PhotoJson): { city: string; country: string; short: string } {
  const ld = localDate(p.takenAt ?? p.at, p.tz);
  const parts = (p.placeEn ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const city = parts.length > 1 ? parts[0] : (parts[0] ?? '');
  const country = parts.length > 1 ? parts.slice(1).join(', ') : '';
  return { city: city.toUpperCase(), country: country.toUpperCase(), short: ld.short };
}

/** 一張明信片的 HTML：照片 + 左下角地名與日期（單一字體）。 */
export function postcardMarkup(p: PhotoJson, opts: { photoUrl: (id: string) => string; rot: number }): string {
  const lb = resolveLabel(p);
  const src = opts.photoUrl(p.photoId!);
  const sub = [lb.country, lb.short].filter(Boolean).join(' · ');
  return `
      <article class="postcard" style="--rot:${opts.rot}deg">
        <div class="pc-photo"><img src="${src}" alt="" />
          <div class="pc-shade"></div>
          <div class="pc-mark">${lb.city ? `<div class="mk-city">${esc(lb.city)}</div>` : ''}<div class="mk-sub">${esc(sub)}</div></div>
        </div>
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
        <button class="pc-pause" id="pc-pause" type="button" aria-label="暫停">❚❚</button>
      </header>
      <div class="pc-lightbox" id="pc-lightbox" hidden>
        <img id="lb-img" alt="" />
        <div class="lb-actions">
          <a class="lb-btn" id="lb-dl" href="#" download aria-label="下載這張照片" title="下載"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg></a>
          <button class="lb-btn" id="lb-close" type="button" aria-label="關閉">✕</button>
        </div>
      </div>
      <div class="pc-deck" id="pc-deck"><p class="pc-empty">載入中…</p></div>
      <div class="pc-mapwrap"><div id="pc-map" class="pc-mapbig"></div></div>
    </div>`;
  const deck = root.querySelector<HTMLElement>('#pc-deck')!;
  const titleEl = root.querySelector<HTMLElement>('#pc-title')!;
  const pauseBtn = root.querySelector<HTMLButtonElement>('#pc-pause')!;
  const lightbox = root.querySelector<HTMLElement>('#pc-lightbox')!;
  const lbImg = root.querySelector<HTMLImageElement>('#lb-img')!;
  const lbDl = root.querySelector<HTMLAnchorElement>('#lb-dl')!;
  let current: PhotoJson | null = null;
  let viewing = false;
  const mapWrap = root.querySelector<HTMLElement>('.pc-mapwrap')!;
  const fileName = (p: PhotoJson): string => `${(resolveLabel(p).city || resolveLabel(p).country || 'photo').replace(/\s+/g, '_')}_${(p.takenAt ?? p.at).slice(0, 10)}.jpg`;
  const openViewer = (): void => {
    if (!current) return;
    lbImg.src = photoUrl(current.photoId!);
    lbDl.href = photoUrl(current.photoId!);
    lbDl.setAttribute('download', fileName(current));
    lightbox.hidden = false;
    mapWrap.classList.add('is-hidden');
    document.body.style.overflow = 'hidden';
    viewing = true;
  };
  const closeViewer = (): void => {
    lightbox.hidden = true;
    mapWrap.classList.remove('is-hidden');
    document.body.style.overflow = '';
    viewing = false;
    lbImg.removeAttribute('src');
  };
  root.querySelector('#lb-close')!.addEventListener('click', closeViewer);
  lightbox.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('.lb-actions')) return;
    closeViewer();
  });
  const photoUrl = (id: string): string => `/api/p/${encodeURIComponent(token)}/${encodeURIComponent(id)}`;

  let title = '';
  let photos: PhotoJson[] = [];
  let order: PhotoJson[] = [];
  let pos = -1;
  let paused = false;
  let timer: number | null = null;
  const INTERVAL = 7000;

  const cardHtml = (p: PhotoJson, rot: number): string => postcardMarkup(p, { photoUrl, rot });

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
    current = p;
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
      if (!paused && !viewing && document.visibilityState === 'visible') next();
    }, INTERVAL);
  };

  pauseBtn.addEventListener('click', () => {
    paused = !paused;
    pauseBtn.textContent = paused ? '▶' : '❚❚';
    pauseBtn.setAttribute('aria-label', paused ? '播放' : '暫停');
  });
  deck.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('.pc-photo')) {
      openViewer();
      return;
    }
    next();
  });
  let tx = 0;
  deck.addEventListener('touchstart', (e) => (tx = e.touches[0].clientX), { passive: true });
  deck.addEventListener(
    'touchend',
    (e) => {
      if (viewing) return;
      const dx = e.changedTouches[0].clientX - tx;
      if (dx < -40) next();
      else if (dx > 40) back();
    },
    { passive: true },
  );
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && viewing) {
      closeViewer();
      return;
    }
    if (viewing) return;
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
