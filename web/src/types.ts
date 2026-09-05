import type { Timestamp } from 'firebase/firestore';

export type CheckinSource = 'shortcut' | 'line' | 'web-gps' | 'manual' | 'photo';

export interface RecentItem {
  id?: string;
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
  /** 免登入打卡頁 token / 連結。 */
  checkinToken: string | null;
  checkinUrl: string | null;
  flights: FlightJson[];
}

/** 免登入打卡頁 GET /api/c/{token} 回傳。 */
export interface CheckinPageJson {
  title: string;
  status: 'active' | 'completed';
  intervalHours: number;
  travelerTz: string;
  lastCheckinAt: string | null;
  lastCheckinPlace: string | null;
  nextDeadlineAt: string | null;
  offlineUntil: string | null;
  alerted: boolean;
}

export interface UserJson {
  uid: string;
  kind: 'session' | 'apikey';
  displayName: string | null;
  pictureUrl: string | null;
}

export interface KeyJson {
  id: string;
  label: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface StatusJson {
  user: UserJson;
  groupBound: boolean;
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

export interface FlightLegJson {
  flightNo: string;
  airline: string | null;
  status: string | null;
  fromIata: string;
  fromCity: string;
  fromTz: string;
  departLocal: string;
  departUtc: string;
  toIata: string;
  toCity: string;
  toTz: string;
  arriveLocal: string;
  arriveUtc: string;
}
