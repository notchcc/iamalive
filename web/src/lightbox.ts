/**
 * 全螢幕照片檢視（家人頁幻燈片、照片回顧頁共用）：
 * 右上角 X 關閉與下載鈕，點背景 / Esc 關閉；多張時可左右滑動（跟著手指移動、放開後滑入下一張）、
 * 點左右箭頭或用方向鍵切換，箭頭 5 秒沒操作淡出、碰畫面再出現；底部顯示說明與「n / N」。
 */
export interface ViewerItem {
  src: string;
  /** 下載檔名；沒有就不顯示下載鈕 */
  download?: string;
  caption?: string;
}

export interface Lightbox {
  open(items: ViewerItem[], index?: number): void;
  close(): void;
  isOpen(): boolean;
  destroy(): void;
}

const DL_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>';
const CHEV_L = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 5-7 7 7 7"/></svg>';
const CHEV_R = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg>';
const NAV_HIDE_MS = 5000;
const SLIDE_MS = 320;
const SWIPE_PX = 48;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

export function createLightbox(opts: { onToggle?: (open: boolean) => void } = {}): Lightbox {
  const el = document.createElement('div');
  el.className = 'pc-lightbox';
  el.hidden = true;
  el.innerHTML = `
    <div class="lb-stage"></div>
    <button class="lb-nav lb-prev" type="button" aria-label="上一張">${CHEV_L}</button>
    <button class="lb-nav lb-next" type="button" aria-label="下一張">${CHEV_R}</button>
    <div class="lb-actions">
      <a class="lb-btn lb-dl" href="#" download aria-label="下載這張照片" title="下載">${DL_ICON}</a>
      <button class="lb-btn lb-close" type="button" aria-label="關閉">✕</button>
    </div>
    <div class="lb-foot"><span class="lb-cap"></span><span class="lb-count"></span></div>`;
  document.body.appendChild(el);
  const stage = el.querySelector<HTMLElement>('.lb-stage')!;
  const prevBtn = el.querySelector<HTMLButtonElement>('.lb-prev')!;
  const nextBtn = el.querySelector<HTMLButtonElement>('.lb-next')!;
  const dl = el.querySelector<HTMLAnchorElement>('.lb-dl')!;
  const cap = el.querySelector<HTMLElement>('.lb-cap')!;
  const count = el.querySelector<HTMLElement>('.lb-count')!;

  let items: ViewerItem[] = [];
  let idx = 0;
  let open = false;
  let navTimer: number | null = null;
  let animating = false;

  const multi = (): boolean => items.length > 1;
  const currentImg = (): HTMLImageElement | null => stage.querySelector<HTMLImageElement>('img:not(.leave)');

  // ---- 箭頭：出現後 5 秒沒操作就淡出 ----
  const showNav = (): void => {
    if (!open) return;
    el.classList.remove('nav-hidden');
    if (navTimer) window.clearTimeout(navTimer);
    navTimer = window.setTimeout(() => el.classList.add('nav-hidden'), NAV_HIDE_MS);
  };

  const renderMeta = (): void => {
    const it = items[idx];
    if (!it) return;
    if (it.download) {
      dl.hidden = false;
      dl.href = it.src;
      dl.setAttribute('download', it.download);
    } else {
      dl.hidden = true;
    }
    cap.innerHTML = it.caption ? esc(it.caption) : '';
    count.textContent = multi() ? `${idx + 1} / ${items.length}` : '';
    prevBtn.hidden = nextBtn.hidden = !multi();
    // 預載前後一張
    [items[idx + 1], items[idx - 1]].forEach((n) => {
      if (n) new Image().src = n.src;
    });
  };

  const makeImg = (src: string): HTMLImageElement => {
    const img = document.createElement('img');
    img.alt = '';
    img.draggable = false;
    img.src = src;
    return img;
  };

  /** 換到 idx；dir=0 不動畫（開啟時），±1 從右 / 左滑入 */
  const show = (dir: 0 | 1 | -1): void => {
    const it = items[idx];
    if (!it) return;
    const old = currentImg();
    const img = makeImg(it.src);
    if (dir === 0 || !old) {
      stage.innerHTML = '';
      stage.appendChild(img);
    } else {
      animating = true;
      img.classList.add(dir === 1 ? 'enter-right' : 'enter-left');
      stage.appendChild(img);
      // 兩次 rAF 確保起始位置先套用再過場
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          img.classList.remove('enter-right', 'enter-left');
          img.classList.add('in');
          old.style.transform = '';
          old.classList.add('leave', dir === 1 ? 'leave-left' : 'leave-right');
        }),
      );
      window.setTimeout(() => {
        old.remove();
        img.classList.remove('in');
        animating = false;
      }, SLIDE_MS + 40);
    }
    renderMeta();
  };
  const go = (d: 1 | -1): void => {
    if (!multi() || animating) return;
    idx = (idx + d + items.length) % items.length;
    show(d);
    showNav();
  };
  const close = (): void => {
    if (!open) return;
    open = false;
    el.hidden = true;
    document.body.style.overflow = '';
    stage.innerHTML = '';
    if (navTimer) window.clearTimeout(navTimer);
    opts.onToggle?.(false);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (!open) return;
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowRight') go(1);
    else if (e.key === 'ArrowLeft') go(-1);
  };
  document.addEventListener('keydown', onKey);
  el.querySelector('.lb-close')!.addEventListener('click', close);
  prevBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    go(-1);
  });
  nextBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    go(1);
  });
  el.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('.lb-actions, .lb-nav')) return;
    if (dragged) return; // 剛滑過不算點擊
    close();
  });
  el.addEventListener('pointermove', showNav);

  // ---- 手勢：跟著手指移動，放開後決定換張或彈回 ----
  let tx = 0;
  let ty = 0;
  let dx = 0;
  let horizontal: boolean | null = null;
  let dragged = false;
  el.addEventListener(
    'touchstart',
    (e) => {
      tx = e.touches[0].clientX;
      ty = e.touches[0].clientY;
      dx = 0;
      horizontal = null;
      dragged = false;
      showNav();
    },
    { passive: true },
  );
  el.addEventListener(
    'touchmove',
    (e) => {
      if (!multi() || animating) return;
      const mx = e.touches[0].clientX - tx;
      const my = e.touches[0].clientY - ty;
      if (horizontal === null && (Math.abs(mx) > 8 || Math.abs(my) > 8)) horizontal = Math.abs(mx) > Math.abs(my);
      if (!horizontal) return;
      dx = mx;
      dragged = true;
      const img = currentImg();
      if (img) {
        img.style.transition = 'none';
        img.style.transform = `translateX(${dx}px)`;
      }
    },
    { passive: true },
  );
  el.addEventListener(
    'touchend',
    () => {
      const img = currentImg();
      if (!img || !horizontal) return;
      img.style.transition = '';
      if (Math.abs(dx) >= SWIPE_PX) {
        go(dx < 0 ? 1 : -1);
      } else {
        img.style.transform = ''; // 彈回
      }
      window.setTimeout(() => (dragged = false), 50);
    },
    { passive: true },
  );

  return {
    open(list, index = 0) {
      if (!list.length) return;
      items = list;
      idx = Math.min(Math.max(0, index), list.length - 1);
      open = true;
      el.hidden = false;
      document.body.style.overflow = 'hidden';
      show(0);
      showNav();
      opts.onToggle?.(true);
    },
    close,
    isOpen: () => open,
    destroy() {
      close();
      document.removeEventListener('keydown', onKey);
      el.remove();
    },
  };
}
