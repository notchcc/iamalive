/**
 * 明信片牌堆（家人頁用）：隨機輪播有照片的打卡，卡片左下角標英文地名與當地日期，
 * 左右箭頭 5 秒自動隱藏，點照片開全螢幕檢視（X / 下載）。
 */

export interface PostcardPhoto {
  photoId: string;
  lat: number;
  lng: number;
  tz: string;
  place: string | null;
  placeEn?: string | null;
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

export function ensurePostcardFonts(): void {
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

/** 一張明信片的 HTML：照片 + 左下角地名與日期（單一字體）。 */
export function postcardMarkup(p: PostcardPhoto, opts: { photoUrl: (id: string) => string; rot: number }): string {
  const lb = resolveLabel(p);
  const src = opts.photoUrl(p.photoId);
  const sub = [lb.country, lb.short].filter(Boolean).join(' · ');
  return `
      <article class="postcard" style="--rot:${opts.rot}deg">
        <div class="pc-photo"><img src="${src}" alt="" />
          <div class="pc-shade"></div>
          <div class="pc-mark">${lb.city ? `<div class="mk-city">${esc(lb.city)}</div>` : ''}<div class="mk-sub">${esc(sub)}</div></div>
        </div>
      </article>`;
}

const CHEV_L = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 5-7 7 7 7"/></svg>';
const CHEV_R = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg>';
const DL_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>';

const NAV_HIDE_MS = 5000;

export function createPostcardDeck(host: HTMLElement, opts: DeckOptions): PostcardDeck {
  ensurePostcardFonts();
  const INTERVAL = opts.intervalMs ?? 7000;
  host.innerHTML = `
    <div class="pc-deck" id="pc-deck">
      <button class="pc-nav pc-nav-prev" type="button" aria-label="上一張">${CHEV_L}</button>
      <button class="pc-nav pc-nav-next" type="button" aria-label="下一張">${CHEV_R}</button>
    </div>
    <div class="pc-lightbox" hidden>
      <img alt="" />
      <div class="lb-actions">
        <a class="lb-btn lb-dl" href="#" download aria-label="下載這張照片" title="下載">${DL_ICON}</a>
        <button class="lb-btn lb-close" type="button" aria-label="關閉">✕</button>
      </div>
    </div>`;
  const deck = host.querySelector<HTMLElement>('.pc-deck')!;
  const prevBtn = host.querySelector<HTMLButtonElement>('.pc-nav-prev')!;
  const nextBtn = host.querySelector<HTMLButtonElement>('.pc-nav-next')!;
  const lightbox = host.querySelector<HTMLElement>('.pc-lightbox')!;
  const lbImg = lightbox.querySelector<HTMLImageElement>('img')!;
  const lbDl = lightbox.querySelector<HTMLAnchorElement>('.lb-dl')!;

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

  // ---- 全螢幕檢視 ----
  const openViewer = (): void => {
    if (!current) return;
    lbImg.src = opts.photoUrl(current.photoId);
    lbDl.href = opts.photoUrl(current.photoId);
    lbDl.setAttribute('download', postcardFileName(current));
    lightbox.hidden = false;
    document.body.style.overflow = 'hidden';
    viewing = true;
  };
  const closeViewer = (): void => {
    lightbox.hidden = true;
    document.body.style.overflow = '';
    viewing = false;
    lbImg.removeAttribute('src');
  };
  lightbox.querySelector('.lb-close')!.addEventListener('click', closeViewer);
  lightbox.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('.lb-actions')) return;
    closeViewer();
  });

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
    const prev = deck.querySelector<HTMLElement>('.postcard:not(.leave)');
    const rot = (Math.random() * 5 - 2.5).toFixed(1);
    deck.insertAdjacentHTML('beforeend', postcardMarkup(p, { photoUrl: opts.photoUrl, rot: Number(rot) }));
    const card = deck.lastElementChild as HTMLElement;
    card.classList.add(dir === 1 ? 'enter-right' : 'enter-left');
    requestAnimationFrame(() => card.classList.add('in'));
    const first = current === null;
    current = p;
    if (prev) {
      prev.classList.add('leave', dir === 1 ? 'leave-left' : 'leave-right');
      window.setTimeout(() => prev.remove(), 700);
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
    if ((e.target as HTMLElement).closest('.pc-photo')) openViewer();
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
    if (e.key === 'Escape' && viewing) {
      closeViewer();
      return;
    }
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
      if (viewing) closeViewer();
    },
  };
}
