import type { Timestamp } from 'firebase/firestore';

export type CheckinSource = 'shortcut' | 'line' | 'web-gps' | 'manual' | 'photo';

export interface RecentItem {
  lat: number;
  lng: number;
  acc: number | null;
  src: CheckinSource;
  tz: string;
  place?: string | null;
  note: string;
  photoId?: string | null;
  takenAt?: Timestamp | null;
  at: Timestamp;
}

export interface FlightSeg {
  flightNo: string;
  fromCity: string;
  fromTz: string;
  departAt: Timestamp;
  toCity: string;
  toTz: string;
  arriveAt: Timestamp;
}

export interface FlightJson {
  flightNo: string;
  fromCity: string;
  fromTz: string;
  departAt: string;
  departLocal: string;
  toCity: string;
  toTz: string;
  arriveAt: string;
  arriveLocal: string;
}

export interface FlightInput {
  flightNo: string;
  fromCity: string;
  fromTz: string;
  departLocal: string;
  toCity: string;
  toTz: string;
  arriveLocal: string;
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
  flights?: FlightSeg[];
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
  lastCheckinPlace: string | null;
  nextDeadlineAt: string;
  offlineUntil: string | null;
  alerted: boolean;
  alertCount: number;
  groupReadToken: string;
  familyUrl: string;
  flights: FlightJson[];
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
