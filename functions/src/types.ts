import type { GeoPoint, Timestamp } from 'firebase-admin/firestore';

export type TripStatus = 'active' | 'completed';
export type CheckinSource = 'shortcut' | 'line' | 'web-gps' | 'manual';

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
  /** 航段（依 departAt 排序），飛行中不警報、期限順延到降落後。 */
  flights: FlightSegment[];
  /** 群組訊息內附的家人頁 token（建立行程時自動產生）。 */
  groupReadToken: string;
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
  createdAt: Timestamp;
  clientAt: Timestamp | null;
}

export interface RecentItem {
  lat: number;
  lng: number;
  acc: number | null;
  src: CheckinSource;
  tz: string;
  place: string | null;
  note: string;
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

export interface LineConfig {
  groupId: string | null;
  joinedAt: Timestamp | null;
  monthKey: string;
  pushCount: number;
}

export type PushKind = 'start' | 'end' | 'offline' | 'alert' | 'recovery';
