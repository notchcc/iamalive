/**
 * /me/go/{target}：LINE 圖文選單的固定入口。經 LIFF 認出使用者後，轉到他目前行程的打卡頁或家人頁。
 * LIFF URL 會把路徑接在 endpoint（/me）後面，所以是 https://liff.line.me/{LIFF_ID}/go/checkin。
 */
import { ApiError, api } from './api';
import { getLiff } from './liff';

export type GoTarget = 'checkin' | 'family' | 'trip';

export function renderGoPage(root: HTMLElement, target: GoTarget): () => void {
  root.innerHTML = `
    <div class="page landing">
      <h1>iamalive</h1>
      <p class="muted" id="go-msg">確認身分中…</p>
      <p><a href="/me">前往管理頁</a></p>
    </div>`;
  const msg = root.querySelector<HTMLElement>('#go-msg')!;

  const run = async (): Promise<void> => {
    if (target === 'trip') {
      location.replace('/me#trip');
      return;
    }
    // 先用既有 cookie；401 再嘗試 LIFF ID token 換 session
    const status = await api.status().catch(async (e) => {
      if (!(e instanceof ApiError && e.status === 401)) throw e;
      const liff = await getLiff();
      if (!liff) return null;
      if (!liff.isLoggedIn()) {
        liff.login({ redirectUri: location.href });
        return null;
      }
      const idToken = liff.getIDToken();
      if (!idToken) return null;
      await api.liffLogin(idToken);
      return api.status();
    });
    if (!status) {
      msg.textContent = '需要登入，正在前往登入…';
      window.setTimeout(() => location.replace('/me'), 800);
      return;
    }
    const t = status.activeTrip;
    if (!t) {
      msg.textContent = '目前沒有進行中的行程，前往建立…';
      window.setTimeout(() => location.replace('/me#trip'), 800);
      return;
    }
    const url = target === 'checkin' ? t.checkinUrl : t.familyUrl;
    if (!url) {
      location.replace('/me#settings');
      return;
    }
    msg.textContent = target === 'checkin' ? '前往打卡頁…' : '前往家人頁…';
    location.replace(url);
  };

  run().catch((e) => {
    msg.textContent = `無法轉導：${e instanceof ApiError ? e.code : String((e as Error)?.message ?? e)}`;
  });
  return () => {
    /* 無需清理 */
  };
}
