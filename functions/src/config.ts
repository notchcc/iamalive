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
/** RapidAPI 金鑰（AeroDataBox 航班查詢）。未設定時航班查詢回 503，其餘功能不受影響。 */
export const RAPIDAPI_KEY = defineSecret('RAPIDAPI_KEY');
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
export const EXT_SECRETS = [RAPIDAPI_KEY];
export const ALL_SECRETS = [...LINE_SECRETS, ...AUTH_SECRETS, ...EXT_SECRETS];

export function familyUrl(readToken: string): string {
  const base = PUBLIC_BASE_URL.value().replace(/\/+$/, '');
  return `${base}/w/${readToken}`;
}

/** 免登入打卡頁（旅人加到主畫面用）。 */
export function checkinUrl(token: string): string {
  const base = PUBLIC_BASE_URL.value().replace(/\/+$/, '');
  return `${base}/c/${token}`;
}

/** LIFF app ID（LINE Login channel 底下、endpoint 為 /me）。空字串表示未設定。 */
export const LIFF_ID = defineString('LIFF_ID', { default: '' });

export function liffUrl(): string | null {
  const id = LIFF_ID.value();
  return id ? `https://liff.line.me/${id}` : null;
}
