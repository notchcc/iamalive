import type { GeoPoint, Timestamp } from 'firebase-admin/firestore';

export type TripStatus = 'active' | 'completed';
export type CheckinSource = 'shortcut' | 'line' | 'web-gps' | 'manual';

export interface Trip {
  title: string;
  startAt: Timestamp;
  endAt: Timestamp;
  intervalHours: number;
  status: TripStatus;
  travelerTz: string;
  lastCheckinAt: Timestamp | null;
  lastCheckinGeo: GeoPoint | null;
  nextDeadlineAt: Timestamp;
  offlineUntil: Timestamp | null;
  alerted: boolean;
  alertCount: number;
  lastAlertAt: Timestamp | null;
  morningResendDue: boolean;
  morningResent: boolean;
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
