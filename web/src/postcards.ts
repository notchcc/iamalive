/**
 * /g/{readToken}：明信片展示頁。隨機輪播這趟旅程的打卡照片，標注拍攝地點與當地日期。
 * 權限同家人頁（同一個 readToken，照片經 /api/p/{token}/{id}）。
 */
import { applyPwaIdentity } from './pwa';

interface PhotoJson {
  id: string;
  lat: number;
  lng: number;
  tz: string;
  place: string | null;
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
      <div class="pc-deck" id="pc-deck"><p class="pc-empty">載入中…</p></div>
      <div class="pc-foot"><span id="pc-counter"></span><span class="pc-hint">點一下或左右滑動換一張</span></div>
    </div>`;
  const deck = root.querySelector<HTMLElement>('#pc-deck')!;
  const titleEl = root.querySelector<HTMLElement>('#pc-title')!;
  const counterEl = root.querySelector<HTMLElement>('#pc-counter')!;
  const pauseBtn = root.querySelector<HTMLButtonElement>('#pc-pause')!;
  const photoUrl = (id: string): string => `/api/p/${encodeURIComponent(token)}/${encodeURIComponent(id)}`;

  let title = '';
  let photos: PhotoJson[] = [];
  let order: PhotoJson[] = [];
  let pos = -1;
  let paused = false;
  let timer: number | null = null;
  const INTERVAL = 7000;

  const cardHtml = (p: PhotoJson, rot: number): string => {
    const ld = localDate(p.takenAt ?? p.at, p.tz);
    const place = p.place ?? `${p.lat.toFixed(3)}, ${p.lng.toFixed(3)}`;
    const [city, ...rest] = place.split(',').map((x) => x.trim());
    return `
      <article class="postcard" style="--rot:${rot}deg">
        <div class="pc-photo"><img src="${photoUrl(p.photoId!)}" alt="" /></div>
        <div class="pc-side">
          <div class="pc-topline">
            <div class="pc-postmark"><span>${esc(ld.short)}</span><small>${esc(city)}</small></div>
            <div class="pc-stamp"><span>${esc(title || 'iamalive')}</span></div>
          </div>
          <h2 class="pc-place">${esc(city)}</h2>
          ${rest.length ? `<div class="pc-region">${esc(rest.join(', '))}</div>` : ''}
          <div class="pc-date">${esc(ld.date)} · ${esc(ld.time)}</div>
          ${p.note ? `<p class="pc-note">${esc(p.note)}</p>` : '<p class="pc-note pc-note-empty">Wish you were here.</p>'}
          <div class="pc-lines"><i></i><i></i><i></i></div>
        </div>
      </article>`;
  };

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
    if (prev) {
      prev.classList.add('leave', dir === 1 ? 'leave-left' : 'leave-right');
      window.setTimeout(() => prev.remove(), 700);
    }
    deck.querySelector('.pc-empty')?.remove();
    counterEl.textContent = `${photos.length} 張照片`;
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
  };
}
