/**
 * 行程領域邏輯：建立、打卡、預告離線、結案、家人連結、views 投影。
 * 所有寫入皆由此模組經 Admin SDK 進行。
 */
import { randomBytes } from 'node:crypto';
import tzlookup from 'tz-lookup';
import { familyUrl } from './config.js';
import { reverseGeocode } from './geocode.js';
import { deletePhoto } from './photos.js';
import { FieldValue, GeoPoint, Timestamp, checkinsCol, db, tripsCol, viewsCol, type TripSnap } from './db.js';
import { endMessages, offlineMessages, pushGroup, recoveryMessages, startMessages } from './line.js';
import { HOUR_MS, TAIPEI, isValidTz } from './time.js';
import type { Checkin, CheckinSource, FlightSegment, RecentItem, Trip, View } from './types.js';

import { HttpError } from './errors.js';
export { HttpError };

export const RECENT_LIMIT = 100;

export function newToken(): string {
  return randomBytes(16).toString('base64url');
}

export function tzFor(lat: number, lng: number): string {
  try {
    const tz = tzlookup(lat, lng);
    return isValidTz(tz) ? tz : 'UTC';
  } catch {
    return 'UTC';
  }
}

export async function getActiveTrip(ownerUid: string): Promise<TripSnap | null> {
  const q = await tripsCol.where('ownerUid', '==', ownerUid).where('status', '==', 'active').limit(1).get();
  return q.empty ? null : q.docs[0];
}

export async function requireActiveTrip(ownerUid: string): Promise<TripSnap> {
  const t = await getActiveTrip(ownerUid);
  if (!t) throw new HttpError(409, 'NO_ACTIVE_TRIP');
  return t;
}

function recentFromCheckins(docs: Array<{ id: string; data: Checkin }>): RecentItem[] {
  return docs.map(({ id, data: c }) => ({
    id,
    lat: c.geo.latitude,
    lng: c.geo.longitude,
    acc: c.accuracy,
    src: c.source,
    tz: c.tz,
    place: c.place ?? null,
    note: c.note,
    photoId: c.photoId ?? null,
    takenAt: c.takenAt ?? null,
    at: c.createdAt,
  }));
}

async function loadRecent(tripId: string, limit = RECENT_LIMIT): Promise<RecentItem[]> {
  const q = await checkinsCol(tripId).orderBy('createdAt', 'desc').limit(limit).get();
  return recentFromCheckins(q.docs.map((d) => ({ id: d.id, data: d.data() })));
}

export function buildView(tripId: string, trip: Trip, label: string, recent: RecentItem[]): View {
  return {
    tripId,
    label,
    title: trip.title,
    status: trip.status,
    travelerTz: trip.travelerTz,
    intervalHours: trip.intervalHours,
    lastCheckinAt: trip.lastCheckinAt,
    nextDeadlineAt: trip.nextDeadlineAt,
    offlineUntil: trip.offlineUntil,
    alerted: trip.alerted,
    flights: trip.flights ?? [],
    recent,
    updatedAt: Timestamp.now(),
  };
}

/**
 * 把 trip 狀態同步到該行程所有 views。若給 batch 則加入其中，否則自行 commit。
 * label 由既有 view 文件保留（讀一次），新 token 由呼叫端先建。
 */
export async function syncViews(
  tripId: string,
  trip: Trip,
  opts: { recent?: RecentItem[]; batch?: FirebaseFirestore.WriteBatch } = {},
): Promise<void> {
  const recent = opts.recent ?? (await loadRecent(tripId));
  const batch = opts.batch ?? db.batch();
  const existing = await Promise.all(trip.readTokens.map((t) => viewsCol.doc(t).get()));
  for (const snap of existing) {
    const label = snap.data()?.label ?? '家人';
    batch.set(snap.ref, buildView(tripId, trip, label, recent));
  }
  if (!opts.batch) await batch.commit();
}

export interface CreateTripInput {
  title: string;
  startAt: Date;
  endAt: Date;
  intervalHours: number;
}

export async function createTrip(ownerUid: string, input: CreateTripInput): Promise<{ id: string; trip: Trip; url: string }> {
  if (await getActiveTrip(ownerUid)) throw new HttpError(409, 'ACTIVE_TRIP_EXISTS');
  const now = new Date();
  const base = input.startAt > now ? input.startAt : now;
  const groupReadToken = newToken();
  const trip: Trip = {
    ownerUid,
    title: input.title,
    startAt: Timestamp.fromDate(input.startAt),
    endAt: Timestamp.fromDate(input.endAt),
    intervalHours: input.intervalHours,
    status: 'active',
    travelerTz: TAIPEI,
    lastCheckinAt: null,
    lastCheckinGeo: null,
    lastCheckinPlace: null,
    nextDeadlineAt: Timestamp.fromDate(new Date(base.getTime() + input.intervalHours * HOUR_MS)),
    offlineUntil: null,
    alerted: false,
    alertCount: 0,
    lastAlertAt: null,
    morningResendDue: false,
    morningResent: false,
    flights: [],
    groupReadToken,
    readTokens: [groupReadToken],
    createdAt: Timestamp.fromDate(now),
    updatedAt: Timestamp.fromDate(now),
  };
  const ref = tripsCol.doc();
  const batch = db.batch();
  batch.set(ref, trip);
  batch.set(viewsCol.doc(groupReadToken), buildView(ref.id, trip, '群組', []));
  await batch.commit();
  const url = familyUrl(groupReadToken);
  await pushGroup(ownerUid, 'start', startMessages(trip, url));
  return { id: ref.id, trip, url };
}

export interface CheckinInput {
  lat: number;
  lng: number;
  accuracy: number | null;
  source: CheckinSource;
  note: string;
  nextHours: number | null;
  clientAt: Date | null;
  photoId?: string | null;
  takenAt?: Date | null;
}

export interface CheckinResult {
  nextDeadlineAt: Date;
  tz: string;
  pushed: boolean;
  recovered: boolean;
}

export async function recordCheckin(snap: TripSnap, input: CheckinInput): Promise<CheckinResult> {
  const trip = snap.data();
  const now = new Date();
  const tz = tzFor(input.lat, input.lng);
  const place = await reverseGeocode(input.lat, input.lng);
  const hours = input.nextHours ?? trip.intervalHours;
  // 行程開始前的打卡：期限從開始時間起算，避免出發前就觸發警報。
  const base = trip.startAt.toDate() > now ? trip.startAt.toDate() : now;
  const nextDeadlineAt = new Date(base.getTime() + hours * HOUR_MS);

  const checkin: Checkin = {
    geo: new GeoPoint(input.lat, input.lng),
    accuracy: input.accuracy,
    source: input.source,
    tz,
    place,
    note: input.note,
    nextHours: input.nextHours,
    photoId: input.photoId ?? null,
    takenAt: input.takenAt ? Timestamp.fromDate(input.takenAt) : null,
    createdAt: Timestamp.fromDate(now),
    clientAt: input.clientAt ? Timestamp.fromDate(input.clientAt) : null,
  };

  const patch: Partial<Trip> = {
    lastCheckinAt: checkin.createdAt,
    lastCheckinGeo: checkin.geo,
    lastCheckinPlace: place,
    travelerTz: tz,
    nextDeadlineAt: Timestamp.fromDate(nextDeadlineAt),
    offlineUntil: null,
    alerted: false,
    alertCount: 0,
    morningResendDue: false,
    morningResent: false,
    updatedAt: checkin.createdAt,
  };
  const updated: Trip = { ...trip, ...patch };

  const prior = await loadRecent(snap.id, RECENT_LIMIT - 1);
  const checkinRef = checkinsCol(snap.id).doc();
  const recent = [...recentFromCheckins([{ id: checkinRef.id, data: checkin }]), ...prior];

  const batch = db.batch();
  batch.set(checkinRef, checkin);
  batch.update(snap.ref, patch);
  await syncViews(snap.id, updated, { recent, batch });
  await batch.commit();

  let pushed = false;
  const recovered = trip.alerted;
  if (recovered) {
    pushed = await pushGroup(
      trip.ownerUid,
      'recovery',
      recoveryMessages(updated, input.lat, input.lng, now, tz, place, input.note, familyUrl(trip.groupReadToken)),
    );
  }
  return { nextDeadlineAt, tz, pushed, recovered };
}

export async function setOffline(snap: TripSnap, hours: number): Promise<{ offlineUntil: Date; nextDeadlineAt: Date; pushed: boolean }> {
  const trip = snap.data();
  const now = new Date();
  const offlineUntil = new Date(now.getTime() + hours * HOUR_MS);
  const nextDeadlineAt = new Date(offlineUntil.getTime() + trip.intervalHours * HOUR_MS);
  const patch: Partial<Trip> = {
    offlineUntil: Timestamp.fromDate(offlineUntil),
    nextDeadlineAt: Timestamp.fromDate(nextDeadlineAt),
    alerted: false,
    alertCount: 0,
    morningResendDue: false,
    morningResent: false,
    updatedAt: Timestamp.fromDate(now),
  };
  const updated: Trip = { ...trip, ...patch };
  const batch = db.batch();
  batch.update(snap.ref, patch);
  await syncViews(snap.id, updated, { batch });
  await batch.commit();
  const pushed = await pushGroup(trip.ownerUid, 'offline', offlineMessages(updated, offlineUntil, familyUrl(trip.groupReadToken)));
  return { offlineUntil, nextDeadlineAt, pushed };
}

export async function endTrip(snap: TripSnap, reason: string): Promise<{ pushed: boolean }> {
  const trip = snap.data();
  const patch: Partial<Trip> = { status: 'completed', updatedAt: Timestamp.now() };
  const updated: Trip = { ...trip, ...patch };
  const batch = db.batch();
  batch.update(snap.ref, patch);
  await syncViews(snap.id, updated, { batch });
  await batch.commit();
  const pushed = await pushGroup(trip.ownerUid, 'end', endMessages(updated, reason, familyUrl(trip.groupReadToken)));
  return { pushed };
}

/** 整批更新航段（依起飛時間排序）。 */
export async function setFlights(snap: TripSnap, flights: FlightSegment[]): Promise<FlightSegment[]> {
  const trip = snap.data();
  const sorted = [...flights].sort((a, b) => a.departAt.toMillis() - b.departAt.toMillis());
  const patch: Partial<Trip> = { flights: sorted, updatedAt: Timestamp.now() };
  const updated: Trip = { ...trip, ...patch };
  const batch = db.batch();
  batch.update(snap.ref, patch);
  await syncViews(snap.id, updated, { batch });
  await batch.commit();
  return sorted;
}

export async function addWatcher(snap: TripSnap, label: string): Promise<{ token: string; url: string }> {
  const trip = snap.data();
  const token = newToken();
  const recent = await loadRecent(snap.id);
  const batch = db.batch();
  batch.set(viewsCol.doc(token), buildView(snap.id, trip, label, recent));
  batch.update(snap.ref, { readTokens: FieldValue.arrayUnion(token), updatedAt: Timestamp.now() });
  await batch.commit();
  return { token, url: familyUrl(token) };
}

export async function removeWatcher(snap: TripSnap, token: string): Promise<void> {
  const trip = snap.data();
  if (token === trip.groupReadToken) throw new HttpError(400, 'CANNOT_REMOVE_GROUP_TOKEN');
  if (!trip.readTokens.includes(token)) throw new HttpError(404, 'TOKEN_NOT_FOUND');
  const batch = db.batch();
  batch.delete(viewsCol.doc(token));
  batch.update(snap.ref, { readTokens: FieldValue.arrayRemove(token), updatedAt: Timestamp.now() });
  await batch.commit();
}

export async function listWatchers(trip: Trip): Promise<Array<{ token: string; label: string; url: string }>> {
  const snaps = await Promise.all(trip.readTokens.map((t) => viewsCol.doc(t).get()));
  return snaps.map((s) => ({ token: s.id, label: s.data()?.label ?? '家人', url: familyUrl(s.id) }));
}

/**
 * 刪除單筆打卡（含照片）。以剩餘最新一筆重算最後回報欄位；nextDeadlineAt 不變。
 */
export async function deleteCheckin(snap: TripSnap, checkinId: string): Promise<void> {
  const ref = checkinsCol(snap.id).doc(checkinId);
  const doc = await ref.get();
  if (!doc.exists) throw new HttpError(404, 'CHECKIN_NOT_FOUND');
  const c = doc.data()!;
  await ref.delete();
  if (c.photoId) await deletePhoto(snap.id, c.photoId);

  const trip = snap.data();
  const latestQ = await checkinsCol(snap.id).orderBy('createdAt', 'desc').limit(1).get();
  const latest = latestQ.empty ? null : latestQ.docs[0].data();
  const patch: Partial<Trip> = {
    lastCheckinAt: latest ? latest.createdAt : null,
    lastCheckinGeo: latest ? latest.geo : null,
    lastCheckinPlace: latest ? (latest.place ?? null) : null,
    travelerTz: latest ? latest.tz : TAIPEI,
    updatedAt: Timestamp.now(),
  };
  const updated: Trip = { ...trip, ...patch };
  const batch = db.batch();
  batch.update(snap.ref, patch);
  await syncViews(snap.id, updated, { batch });
  await batch.commit();
}

/**
 * 把照片附到最近一筆打卡（須在 withinMs 內且尚無照片）。成功回傳 true。
 */
export async function attachPhotoToLastCheckin(snap: TripSnap, photoId: string, takenAt: Date | null, withinMs: number): Promise<boolean> {
  const q = await checkinsCol(snap.id).orderBy('createdAt', 'desc').limit(1).get();
  if (q.empty) return false;
  const doc = q.docs[0];
  const c = doc.data();
  if (c.photoId) return false;
  if (Date.now() - c.createdAt.toMillis() > withinMs) return false;
  await doc.ref.update({ photoId, takenAt: takenAt ? Timestamp.fromDate(takenAt) : (c.takenAt ?? null) });
  await syncViews(snap.id, snap.data());
  return true;
}

/** 重新產生 views 投影（資料結構升級後用）。 */
export async function resyncTrip(snap: TripSnap): Promise<void> {
  await syncViews(snap.id, snap.data());
}

/** 「備註 xxx」指令：補到最後一筆打卡。 */
export async function updateLastNote(snap: TripSnap, note: string): Promise<boolean> {
  const q = await checkinsCol(snap.id).orderBy('createdAt', 'desc').limit(1).get();
  if (q.empty) return false;
  await q.docs[0].ref.update({ note });
  await syncViews(snap.id, snap.data());
  return true;
}

export async function recentForTrip(tripId: string, limit = 5): Promise<RecentItem[]> {
  return loadRecent(tripId, limit);
}
