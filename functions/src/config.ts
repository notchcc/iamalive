import { defineSecret, defineString } from 'firebase-functions/params';

export const REGION = 'asia-east1';

/** 旅行者寫入 token（捷徑與 /me 使用）。 */
export const WRITE_TOKEN = defineSecret('WRITE_TOKEN');
/** LINE Messaging API channel secret（驗證 webhook 簽章）。 */
export const LINE_CHANNEL_SECRET = defineSecret('LINE_CHANNEL_SECRET');
/** LINE Messaging API 長效 channel access token。 */
export const LINE_CHANNEL_ACCESS_TOKEN = defineSecret('LINE_CHANNEL_ACCESS_TOKEN');
/** 旅行者本人的 LINE userId；webhook 只接受此人的位置訊息與指令。 */
export const TRAVELER_LINE_UID = defineSecret('TRAVELER_LINE_UID');

/**
 * 對外網址（Hosting），用來組家人頁連結，例如 https://your-project.web.app。
 * 於 functions/.env 設定 PUBLIC_BASE_URL=...
 */
export const PUBLIC_BASE_URL = defineString('PUBLIC_BASE_URL', { default: '' });

/** 照片 bucket（私有，只由 Functions 存取）。於 functions/.env 設定 PHOTO_BUCKET=... */
export const PHOTO_BUCKET = defineString('PHOTO_BUCKET', { default: '' });

export const LINE_SECRETS = [LINE_CHANNEL_SECRET, LINE_CHANNEL_ACCESS_TOKEN, TRAVELER_LINE_UID];
export const ALL_SECRETS = [WRITE_TOKEN, ...LINE_SECRETS];

export function familyUrl(readToken: string): string {
  const base = PUBLIC_BASE_URL.value().replace(/\/+$/, '');
  return `${base}/w/${readToken}`;
}
