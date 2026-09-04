import type { Timestamp } from 'firebase/firestore';

export type CheckinSource = 'shortcut' | 'line' | 'web-gps' | 'manual';

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
  status: 'active' | 'completed';
  travelerTz: string;
  intervalHours: number;
  lastCheckinAt: Timestamp | null;
  nextDeadlineAt: Timestamp;
  offlineUntil: Timestamp | null;
  alerted: boolean;
  recent: RecentItem[];
  updatedAt: Timestamp;
}

export interface TripJson {
  id: string;
  title: string;
  status: 'active' | 'completed';
  startAt: string;
  endAt: string;
  intervalHours: number;
  travelerTz: string;
  lastCheckinAt: string | null;
  lastCheckinGeo: { lat: number; lng: number } | null;
  nextDeadlineAt: string;
  offlineUntil: string | null;
  alerted: boolean;
  alertCount: number;
  groupReadToken: string;
  familyUrl: string;
}

export interface StatusJson {
  groupBound: boolean;
  joinedAt: string | null;
  monthKey: string;
  pushCount: number;
  monthlyQuota: number;
  activeTrip: TripJson | null;
}

export interface WatcherJson {
  token: string;
  label: string;
  url: string;
}
