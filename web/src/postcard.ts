/**
 * 照片幻燈片（家人頁用）：隨機輪播有照片的打卡，字幕為地點、打卡當地日期時間與備註，
 * 左右箭頭 5 秒自動隱藏，點照片開全螢幕檢視（X / 下載）。
 */
import { createLightbox } from './lightbox';
import { fmtDateTime, tzLabel } from './time';

export interface PostcardPhoto {
  photoId: string;
  lat: number;
  lng: number;
  tz: string;
  place: string | null;
  placeEn?: string | null;
  note?: string;
  takenAt: string | null; // ISO
  at: string; // ISO
}

export interface DeckOptions {
  photoUrl: (id: string) => string;
  /** 換卡（含自動輪播）時呼叫；manual 表示使用者按箭頭 / 滑動 / 按鍵 */
  onChange?: (p: PostcardPhoto, manual: boolean) => void;
  /** 牌堆快用完時呼叫，讓外層補更多照片 */
  onNeedMore?: () => void;
  intervalMs?: number;
}

export interface PostcardDeck {
  /** 設定 / 補充照片；已在牌堆內的略過，新照片（front=true）排在下一張 */
  addPhotos(items: PostcardPhoto[], opts?: { front?: boolean }): void;
  count(): number;
  destroy(): void;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function shortDate(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(iso)).toUpperCase();
}

/** 地名一律英文：placeEn 的城市；沒有城市就用國名；完全沒有就留空只顯示日期。 */
export function resolveLabel(p: PostcardPhoto): { city: string; country: string; short: string } {
  const parts = (p.placeEn ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const city = parts.length > 1 ? parts[0] : (parts[0] ?? '');
  const country = parts.length > 1 ? parts.slice(1).join(', ') : '';
  return { city: city.toUpperCase(), country: country.toUpperCase(), short: shortDate(p.takenAt ?? p.at, p.tz) };
}

export function postcardFileName(p: PostcardPhoto): string {
  const lb = resolveLabel(p);
  return `${(lb.city || lb.country || 'photo').replace(/\s+/g, '_')}_${(p.takenAt ?? p.at).slice(0, 10)}.jpg`;
}

/** 一張幻燈片的 HTML：滿版照片 + 底部字幕（地點、打卡當地日期時間、備註）。 */
export function slideMarkup(p: PostcardPhoto, photoUrl: (id: string) => string): string {
  const when = fmtDateTime(new Date(p.at), p.tz);
  return `
      <figure class="slide">
        <img src="${photoUrl(p.photoId)}" alt="" />
        <figcaption><span>${esc(p.place || tzLabel(p.tz))}</span><span class="when">${esc(when)}</span>${p.note ? `<span class="note">「${esc(p.note)}」</span>` : ''}</figcaption>
      </figure>`;
}

const CHEV_L = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 5-7 7 7 7"/></svg>';
const CHEV_R = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg>';

const NAV_HIDE_MS = 5000;

export function createPostcardDeck(host: HTMLElement, opts: DeckOptions): PostcardDeck {
  const INTERVAL = opts.intervalMs ?? 7000;
  host.innerHTML = `
    <div class="pc-deck" id="pc-deck">
      <button class="pc-nav pc-nav-prev" type="button" aria-label="上一張">${CHEV_L}</button>
      <button class="pc-nav pc-nav-next" type="button" aria-label="下一張">${CHEV_R}</button>
    </div>`;
  const deck = host.querySelector<HTMLElement>('.pc-deck')!;
  const prevBtn = host.querySelector<HTMLButtonElement>('.pc-nav-prev')!;
  const nextBtn = host.querySelector<HTMLButtonElement>('.pc-nav-next')!;

  const photos: PostcardPhoto[] = [];
  const known = new Set<string>();
  let order: PostcardPhoto[] = [];
  let pos = -1;
  let current: PostcardPhoto | null = null;
  let viewing = false;
  let timer: number | null = null;
  let navTimer: number | null = null;
  let started = false;

  // ---- 箭頭：出現後 5 秒沒操作就淡出；碰到卡片再出現 ----
  const showNav = (): void => {
    deck.classList.remove('nav-hidden');
    if (navTimer) window.clearTimeout(navTimer);
    navTimer = window.setTimeout(() => deck.classList.add('nav-hidden'), NAV_HIDE_MS);
  };

  // ---- 全螢幕檢視（共用元件）：帶入已載入的全部照片（新到舊），可左右滑看其他張；
  //      關閉時若看的不是原本那張，幻燈片就切到那一張（視同手動換張，地圖會跟著飛） ----
  let viewerList: PostcardPhoto[] = [];
  const lightbox = createLightbox({
    onToggle: (open) => (viewing = open),
    onClose: (i) => {
      const p = viewerList[i];
      viewerList = [];
      if (!p || p === current) return;
      order = [...order.slice(0, pos + 1), p, ...order.slice(pos + 1)];
      next(true);
    },
  });
  const caption = (p: PostcardPhoto): string => [p.place || tzLabel(p.tz), fmtDateTime(new Date(p.at), p.tz)].join(' · ');
  const openViewer = (): void => {
    if (!current) return;
    viewerList = [...photos].sort((a, b) => (a.at < b.at ? 1 : -1));
    const i = Math.max(0, viewerList.indexOf(current));
    lightbox.open(
      viewerList.map((p) => ({ src: opts.photoUrl(p.photoId), download: postcardFileName(p), caption: caption(p) })),
      i,
    );
  };

  const preload = (p: PostcardPhoto | undefined): void => {
    if (p) new Image().src = opts.photoUrl(p.photoId);
  };

  const nextItem = (): PostcardPhoto | null => {
    if (!photos.length) return null;
    pos++;
    if (pos >= order.length) {
      const last = order[order.length - 1];
      let round = shuffle(photos);
      if (round.length > 1 && round[0] === last) round = [...round.slice(1), round[0]];
      order = [...order, ...round];
    }
    if (order.length - pos <= 3) opts.onNeedMore?.();
    return order[pos];
  };

  const show = (p: PostcardPhoto, dir: 1 | -1, manual: boolean): void => {
    const prev = deck.querySelector<HTMLElement>('.slide:not(.leave)');
    deck.insertAdjacentHTML('beforeend', slideMarkup(p, opts.photoUrl));
    const card = deck.lastElementChild as HTMLElement;
    card.classList.add(dir === 1 ? 'enter-right' : 'enter-left');
    requestAnimationFrame(() => card.classList.add('in'));
    const first = current === null;
    current = p;
    if (prev) {
      prev.classList.add('leave', dir === 1 ? 'leave-left' : 'leave-right');
      window.setTimeout(() => prev.remove(), 600);
    }
    prevBtn.disabled = pos <= 0;
    deck.classList.add('has-cards');
    preload(order[pos + 1]);
    if (!first || manual) opts.onChange?.(p, manual);
  };

  const next = (manual: boolean): void => {
    const p = nextItem();
    if (p) show(p, 1, manual);
    restart();
  };
  const back = (): void => {
    if (pos <= 0) return;
    pos--;
    show(order[pos], -1, true);
    restart();
  };
  const restart = (): void => {
    if (timer) window.clearInterval(timer);
    timer = window.setInterval(() => {
      if (!viewing && document.visibilityState === 'visible') next(false);
    }, INTERVAL);
  };

  prevBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    showNav();
    back();
  });
  nextBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    showNav();
    next(true);
  });
  deck.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('.slide')) openViewer();
  });
  deck.addEventListener('pointerenter', showNav);
  deck.addEventListener('pointermove', showNav);
  let tx = 0;
  let ty = 0;
  deck.addEventListener(
    'touchstart',
    (e) => {
      tx = e.touches[0].clientX;
      ty = e.touches[0].clientY;
      showNav();
    },
    { passive: true },
  );
  deck.addEventListener(
    'touchend',
    (e) => {
      if (viewing) return;
      const dx = e.changedTouches[0].clientX - tx;
      const dy = e.changedTouches[0].clientY - ty;
      if (Math.abs(dx) < 40 || Math.abs(dy) > Math.abs(dx)) return;
      if (dx < 0) next(true);
      else back();
    },
    { passive: true },
  );
  const onKey = (e: KeyboardEvent): void => {
    if (viewing) return;
    if (e.key === 'ArrowRight') next(true);
    else if (e.key === 'ArrowLeft') back();
  };
  document.addEventListener('keydown', onKey);

  return {
    addPhotos(items, o = {}) {
      const fresh = items.filter((p) => p.photoId && !known.has(p.photoId));
      if (!fresh.length) return;
      fresh.forEach((p) => known.add(p.photoId));
      photos.push(...fresh);
      if (!started) {
        started = true;
        order = shuffle(photos);
        pos = -1;
        next(false);
        showNav();
        return;
      }
      if (o.front) {
        // 新照片排在下一張，其餘照常
        order = [...order.slice(0, pos + 1), ...fresh, ...order.slice(pos + 1)];
      } else {
        // 尚未播到的部分重洗，讓新載入的照片也有機會出現
        order = [...order.slice(0, pos + 1), ...shuffle([...order.slice(pos + 1), ...fresh])];
      }
      preload(order[pos + 1]);
    },
    count: () => photos.length,
    destroy() {
      if (timer) window.clearInterval(timer);
      if (navTimer) window.clearTimeout(navTimer);
      document.removeEventListener('keydown', onKey);
      lightbox.destroy();
    },
  };
}
