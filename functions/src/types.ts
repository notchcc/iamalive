import type { GeoPoint, Timestamp } from 'firebase-admin/firestore';

export type TripStatus = 'active' | 'completed';
export type CheckinSource = 'shortcut' | 'line' | 'web-gps' | 'manual' | 'photo';

export interface FlightSegment {
  flightNo: string;
  fromCity: string;
  fromTz: string;
  /** 起飛（UTC） */
  departAt: Timestamp;
  toCity: string;
  toTz: string;
  /** 降落（UTC） */
  arriveAt: Timestamp;
}

export interface Trip {
  /** 擁有者（LINE userId）。 */
  ownerUid: string;
  title: string;
  startAt: Timestamp;
  endAt: Timestamp;
  intervalHours: number;
  status: TripStatus;
  travelerTz: string;
  lastCheckinAt: Timestamp | null;
  lastCheckinGeo: GeoPoint | null;
  /** 最後位置的「城市, 國家」（反向地理編碼），查不到為 null。 */
  lastCheckinPlace: string | null;
  nextDeadlineAt: Timestamp;
  offlineUntil: Timestamp | null;
  alerted: boolean;
  alertCount: number;
  lastAlertAt: Timestamp | null;
  morningResendDue: boolean;
  morningResent: boolean;
  /** 上次「到期前提醒」對應的有效期限；同一期限只私訊旅人一次。舊資料可能沒有此欄位。 */
  reminderSentFor?: Timestamp | null;
  /** 航段（依 departAt 排序），飛行中不警報、期限順延到降落後。 */
  flights: FlightSegment[];
  /** 群組訊息內附的家人頁 token（建立行程時自動產生）。 */
  groupReadToken: string;
  /** 免登入打卡頁 /c/{token} 的能力型 token；可輪替。舊資料可能沒有，讀取時補上。 */
  checkinToken?: string | null;
  readTokens: string[];
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface Checkin {
  geo: GeoPoint;
  accuracy: number | null;
  source: CheckinSource;
  tz: string;
  /** 「城市, 國家」，反向地理編碼結果，查不到為 null。 */
  place: string | null;
  note: string;
  nextHours: number | null;
  /** 照片 ID（GCS 物件名），無照片為 null。 */
  photoId: string | null;
  /** 照片拍攝時間（EXIF），無則 null。期限仍以 createdAt 計算。 */
  takenAt: Timestamp | null;
  createdAt: Timestamp;
  clientAt: Timestamp | null;
}

export interface RecentItem {
  /** checkin 文件 ID，供 /me 刪除用。 */
  id: string;
  lat: number;
  lng: number;
  acc: number | null;
  src: CheckinSource;
  tz: string;
  place: string | null;
  note: string;
  photoId: string | null;
  takenAt: Timestamp | null;
  at: Timestamp;
}

export interface View {
  tripId: string;
  label: string;
  title: string;
  status: TripStatus;
  travelerTz: string;
  intervalHours: number;
  lastCheckinAt: Timestamp | null;
  nextDeadlineAt: Timestamp;
  offlineUntil: Timestamp | null;
  alerted: boolean;
  flights: FlightSegment[];
  recent: RecentItem[];
  updatedAt: Timestamp;
}

/** 全域推播額度計數（config/line）。 */
export interface LineConfig {
  monthKey: string;
  pushCount: number;
}

export interface User {
  displayName: string;
  pictureUrl: string | null;
  createdAt: Timestamp;
  lastLoginAt: Timestamp;
}

/** apiKeys/{sha256(key)} */
export interface ApiKey {
  uid: string;
  label: string;
  /** 金鑰前 8 碼，列表辨識用。 */
  prefix: string;
  createdAt: Timestamp;
  lastUsedAt: Timestamp | null;
}

/** groups/{lineGroupId}：一個群組綁一位擁有者。 */
export interface GroupBinding {
  ownerUid: string;
  boundAt: Timestamp;
}

/** bindCodes/{6位數}：/me 產生，10 分鐘有效，在群組輸入「綁定 123456」使用。 */
export interface BindCode {
  uid: string;
  expiresAt: Timestamp;
}

export type PushKind = 'start' | 'end' | 'offline' | 'alert' | 'recovery' | 'reminder';

/** pendingPhotos/{uid}：等待配對位置的照片（15 分鐘）。 */
export interface PendingPhoto {
  tripId: string;
  photoId: string;
  takenAt: Timestamp | null;
  createdAt: Timestamp;
  expiresAt: Timestamp;
}
