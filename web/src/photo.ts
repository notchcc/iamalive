/**
 * 照片打卡的客戶端處理：讀 EXIF（GPS、拍攝時間、精度）與縮圖。
 */
import exifr from 'exifr';

export interface PhotoMeta {
  lat: number | null;
  lng: number | null;
  accuracy: number | null;
  takenAt: Date | null;
}

export async function extractPhotoMeta(file: File): Promise<PhotoMeta> {
  const out: PhotoMeta = { lat: null, lng: null, accuracy: null, takenAt: null };
  try {
    const gps = await exifr.gps(file);
    if (gps && Number.isFinite(gps.latitude) && Number.isFinite(gps.longitude)) {
      out.lat = gps.latitude;
      out.lng = gps.longitude;
    }
  } catch {
    /* 無 GPS */
  }
  try {
    const tags = (await exifr.parse(file, { pick: ['DateTimeOriginal', 'CreateDate', 'GPSHPositioningError'] })) as
      | { DateTimeOriginal?: Date; CreateDate?: Date; GPSHPositioningError?: number }
      | undefined;
    const d = tags?.DateTimeOriginal ?? tags?.CreateDate;
    if (d instanceof Date && !Number.isNaN(d.getTime())) out.takenAt = d;
    if (typeof tags?.GPSHPositioningError === 'number' && tags.GPSHPositioningError > 0) out.accuracy = tags.GPSHPositioningError;
  } catch {
    /* 無 EXIF */
  }
  return out;
}

/**
 * 縮到最長邊 maxSide、輸出 JPEG。解碼失敗（如 HEIC 在非 Safari）時回傳原檔。
 * 註：canvas 重新編碼會移除 EXIF，位置與時間另以欄位傳送。
 */
export async function shrinkImage(file: File, maxSide = 1600, quality = 0.82): Promise<{ blob: Blob; type: string; resized: boolean }> {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (!blob) throw new Error('toBlob failed');
    return { blob, type: 'image/jpeg', resized: true };
  } catch {
    return { blob: file, type: file.type || 'image/jpeg', resized: false };
  }
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
