/**
 * 頁面底部的「本頁連結」列：顯示目前網址，複製 / 開啟（LIFF 內以外部瀏覽器開啟）。
 * 家人頁與打卡頁共用，方便在 LINE 內把連結轉給別人或加到主畫面。
 */
import { getLiff } from './liff';

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

function toast(msg: string, kind: 'ok' | 'err' = 'ok'): void {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  document.body.appendChild(el);
  window.setTimeout(() => el.remove(), 4000);
}

export function renderShareBar(el: HTMLElement, url: string, hint: string, opts: { collapsed?: boolean } = {}): void {
  el.innerHTML = opts.collapsed
    ? `
    <details class="share share-collapsed">
      <summary><span class="lbl">本頁連結</span></summary>
      <div class="row">
        <input id="share-url" readonly value="${esc(url)}" />
        <button id="share-copy" class="secondary" type="button">複製</button>
        <button id="share-open" class="secondary" type="button">開啟</button>
      </div>
      <p class="muted small">${esc(hint)}</p>
    </details>`
    : `
    <section class="card share">
      <h2>本頁連結</h2>
      <div class="row">
        <input id="share-url" readonly value="${esc(url)}" />
        <button id="share-copy" class="secondary" type="button">複製</button>
        <button id="share-open" class="secondary" type="button">開啟</button>
      </div>
      <p class="muted small">${esc(hint)}</p>
    </section>`;
  const input = el.querySelector<HTMLInputElement>('#share-url')!;
  el.querySelector('#share-copy')!.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast('已複製連結');
    } catch {
      input.focus();
      input.select();
      toast('無法自動複製，請長按選取', 'err');
    }
  });
  el.querySelector('#share-open')!.addEventListener('click', async () => {
    const liff = await getLiff().catch(() => null);
    if (liff && liff.isInClient()) {
      // LIFF 內：用外部瀏覽器（Safari）開，才能加到主畫面
      liff.openWindow({ url, external: true });
      return;
    }
    window.open(url, '_blank', 'noopener');
  });
}
