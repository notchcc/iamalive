import './style.css';
import { renderFamilyPage } from './family';
import { renderMePage } from './me';
import { renderCheckinPage } from './checkin-page';
import { renderGoPage, type GoTarget } from './go';
import { getLiff } from './liff';

const root = document.getElementById('app')!;

function route(): void {
  const path = location.pathname.replace(/\/+$/, '') || '/';
  const family = path.match(/^\/w\/([A-Za-z0-9_-]{16,64})$/);
  if (family) {
    renderFamilyPage(root, family[1]);
  } else if (path === '/me') {
    renderMePage(root);
  } else if (path.match(/^\/me\/go\/(checkin|family|trip)$/)) {
    renderGoPage(root, path.slice('/me/go/'.length) as GoTarget);
  } else if (path.match(/^\/c\/([A-Za-z0-9_-]{16,64})$/)) {
    renderCheckinPage(root, path.slice(3));
  } else {
    root.innerHTML = `
    <div class="page landing">
      <h1>iamalive</h1>
      <p class="muted">旅行報平安。請使用旅行者提供的連結開啟。</p>
      <p><a href="/me">管理頁</a></p>
    </div>`;
  }
}

async function boot(): Promise<void> {
  // LIFF 帶路徑的網址（https://liff.line.me/{id}/go/checkin）會先落在 endpoint
  // /me?liff.state=/go/checkin，由 liff.init() 依 liff.state 導到 /me/go/checkin。
  // 所以只要看到 liff.state 就先初始化 LIFF，讓它完成轉導；沒導走才照一般路由。
  const q = new URLSearchParams(location.search);
  if (q.has('liff.state')) {
    root.innerHTML = '<div class="page landing"><p class="muted">載入中…</p></div>';
    await getLiff();
    const state = q.get('liff.state') ?? '';
    // 保險：SDK 沒導走（例如初始化失敗）就自己導
    if (state.startsWith('/') && location.search.includes('liff.state')) {
      location.replace(`${location.pathname.replace(/\/+$/, '')}${state}`);
      return;
    }
  }
  route();
}

void boot();
