import { defineSecret, defineString } from 'firebase-functions/params';

export const REGION = 'asia-east1';

/** LINE Messaging API channel secret（驗證 webhook 簽章）。 */
export const LINE_CHANNEL_SECRET = defineSecret('LINE_CHANNEL_SECRET');
/** LINE Messaging API 長效 channel access token。 */
export const LINE_CHANNEL_ACCESS_TOKEN = defineSecret('LINE_CHANNEL_ACCESS_TOKEN');
/** LINE Login channel secret（授權碼交換用）。 */
export const LINE_LOGIN_CHANNEL_SECRET = defineSecret('LINE_LOGIN_CHANNEL_SECRET');
/** session JWT 簽章金鑰（≥ 32 bytes 隨機）。 */
export const SESSION_SECRET = defineSecret('SESSION_SECRET');
/** LINE Login channel ID（非機密）。於 functions/.env 設定。 */
export const LINE_LOGIN_CHANNEL_ID = defineString('LINE_LOGIN_CHANNEL_ID', { default: '' });

/**
 * 對外網址（Hosting），用來組家人頁連結，例如 https://your-project.web.app。
 * 於 functions/.env 設定 PUBLIC_BASE_URL=...
 */
export const PUBLIC_BASE_URL = defineString('PUBLIC_BASE_URL', { default: '' });

/** 照片 bucket（私有，只由 Functions 存取）。於 functions/.env 設定 PHOTO_BUCKET=... */
export const PHOTO_BUCKET = defineString('PHOTO_BUCKET', { default: '' });

export const LINE_SECRETS = [LINE_CHANNEL_SECRET, LINE_CHANNEL_ACCESS_TOKEN];
export const AUTH_SECRETS = [LINE_LOGIN_CHANNEL_SECRET, SESSION_SECRET];
export const ALL_SECRETS = [...LINE_SECRETS, ...AUTH_SECRETS];

export function familyUrl(readToken: string): string {
  const base = PUBLIC_BASE_URL.value().replace(/\/+$/, '');
  return `${base}/w/${readToken}`;
}
