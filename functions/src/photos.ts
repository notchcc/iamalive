/**
 * 照片儲存：私有 GCS bucket，只由 Functions 讀寫。
 * 家人頁透過 GET /api/p/{readToken}/{photoId} 取圖，伺服器驗證 token 後串流回傳。
 */
import { randomBytes } from 'node:crypto';
import { getStorage } from 'firebase-admin/storage';
import { PHOTO_BUCKET } from './config.js';

export const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp']);

function bucket() {
  return getStorage().bucket(PHOTO_BUCKET.value());
}

function objectPath(tripId: string, photoId: string): string {
  return `photos/${tripId}/${photoId}`;
}

export function isAllowedImage(contentType: string): boolean {
  return ALLOWED.has(contentType.toLowerCase());
}

export async function savePhoto(tripId: string, data: Buffer, contentType: string): Promise<string> {
  const photoId = randomBytes(12).toString('base64url');
  const file = bucket().file(objectPath(tripId, photoId));
  await file.save(data, {
    contentType,
    resumable: false,
    metadata: { cacheControl: 'private, max-age=31536000' },
  });
  return photoId;
}

export async function readPhoto(tripId: string, photoId: string): Promise<{ data: Buffer; contentType: string } | null> {
  if (!/^[A-Za-z0-9_-]{8,32}$/.test(photoId)) return null;
  const file = bucket().file(objectPath(tripId, photoId));
  const [exists] = await file.exists();
  if (!exists) return null;
  const [meta] = await file.getMetadata();
  const [data] = await file.download();
  return { data, contentType: String(meta.contentType ?? 'image/jpeg') };
}

/** 刪除照片；不存在時靜默。 */
export async function deletePhoto(tripId: string, photoId: string): Promise<void> {
  try {
    await bucket().file(objectPath(tripId, photoId)).delete({ ignoreNotFound: true });
  } catch {
    /* 忽略：照片遺失不應阻止刪除紀錄 */
  }
}
