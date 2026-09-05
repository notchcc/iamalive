/**
 * LIFF 包裝：有設定 VITE_LIFF_ID 才初始化；失敗（例如非 LIFF 環境的初始化錯誤）就回 null，
 * 頁面退回一般瀏覽器 LINE Login。
 */
import type { Liff } from '@line/liff';

let pending: Promise<Liff | null> | null = null;

export function getLiff(): Promise<Liff | null> {
  if (pending) return pending;
  const liffId = (import.meta.env.VITE_LIFF_ID as string | undefined)?.trim();
  if (!liffId) return (pending = Promise.resolve(null));
  pending = import('@line/liff')
    .then(async (m) => {
      const liff = m.default;
      await liff.init({ liffId, withLoginOnExternalBrowser: false });
      return liff;
    })
    .catch((e) => {
      console.warn('liff init failed', e);
      return null;
    });
  return pending;
}
