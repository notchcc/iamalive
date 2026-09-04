import './style.css';
import { renderFamilyPage } from './family';
import { renderMePage } from './me';

const root = document.getElementById('app')!;
const path = location.pathname.replace(/\/+$/, '') || '/';

const family = path.match(/^\/w\/([A-Za-z0-9_-]{16,64})$/);
if (family) {
  renderFamilyPage(root, family[1]);
} else if (path === '/me') {
  renderMePage(root);
} else {
  root.innerHTML = `
    <div class="page landing">
      <h1>iamalive</h1>
      <p class="muted">旅行報平安。請使用旅行者提供的連結開啟。</p>
      <p><a href="/me">管理頁</a></p>
    </div>`;
}
