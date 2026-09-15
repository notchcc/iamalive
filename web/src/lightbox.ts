/**
 * 全螢幕照片檢視（家人頁幻燈片、照片回顧頁共用）：
 * 右上角 X 關閉與下載鈕，點背景 / Esc 關閉；多張時可左右滑動或用方向鍵切換，底部顯示「n / N」與說明。
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

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

export function createLightbox(opts: { onToggle?: (open: boolean) => void } = {}): Lightbox {
  const el = document.createElement('div');
  el.className = 'pc-lightbox';
  el.hidden = true;
  el.innerHTML = `
    <img alt="" />
    <div class="lb-actions">
      <a class="lb-btn lb-dl" href="#" download aria-label="下載這張照片" title="下載">${DL_ICON}</a>
      <button class="lb-btn lb-close" type="button" aria-label="關閉">✕</button>
    </div>
    <div class="lb-foot"><span class="lb-cap"></span><span class="lb-count"></span></div>`;
  document.body.appendChild(el);
  const img = el.querySelector<HTMLImageElement>('img')!;
  const dl = el.querySelector<HTMLAnchorElement>('.lb-dl')!;
  const cap = el.querySelector<HTMLElement>('.lb-cap')!;
  const count = el.querySelector<HTMLElement>('.lb-count')!;

  let items: ViewerItem[] = [];
  let idx = 0;
  let open = false;

  const render = (): void => {
    const it = items[idx];
    if (!it) return;
    img.src = it.src;
    if (it.download) {
      dl.hidden = false;
      dl.href = it.src;
      dl.setAttribute('download', it.download);
    } else {
      dl.hidden = true;
    }
    cap.innerHTML = it.caption ? esc(it.caption) : '';
    count.textContent = items.length > 1 ? `${idx + 1} / ${items.length}` : '';
    // 預載前後一張
    [items[idx + 1], items[idx - 1]].forEach((n) => {
      if (n) new Image().src = n.src;
    });
  };
  const go = (d: 1 | -1): void => {
    if (items.length < 2) return;
    idx = (idx + d + items.length) % items.length;
    render();
  };
  const close = (): void => {
    if (!open) return;
    open = false;
    el.hidden = true;
    document.body.style.overflow = '';
    img.removeAttribute('src');
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
  el.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('.lb-actions')) return;
    close();
  });
  let tx = 0;
  let ty = 0;
  el.addEventListener('touchstart', (e) => ((tx = e.touches[0].clientX), (ty = e.touches[0].clientY)), { passive: true });
  el.addEventListener(
    'touchend',
    (e) => {
      const dx = e.changedTouches[0].clientX - tx;
      const dy = e.changedTouches[0].clientY - ty;
      if (Math.abs(dx) < 40 || Math.abs(dy) > Math.abs(dx)) return;
      go(dx < 0 ? 1 : -1);
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
      render();
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
