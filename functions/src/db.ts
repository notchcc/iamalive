import { getApps, initializeApp } from 'firebase-admin/app';
import {
  FieldValue,
  GeoPoint,
  Timestamp,
  getFirestore,
  type CollectionReference,
  type DocumentData,
  type DocumentReference,
  type FirestoreDataConverter,
  type QueryDocumentSnapshot,
} from 'firebase-admin/firestore';
import type { ApiKey, BindCode, Checkin, GroupBinding, LineConfig, PendingPhoto, Trip, User, View } from './types.js';

if (getApps().length === 0) initializeApp();

export const db = getFirestore();
export { FieldValue, GeoPoint, Timestamp };

function typed<T extends DocumentData>(): FirestoreDataConverter<T> {
  return {
    toFirestore: (data: T) => data,
    fromFirestore: (snap: QueryDocumentSnapshot) => snap.data() as T,
  };
}

export const tripsCol = db.collection('trips').withConverter(typed<Trip>()) as CollectionReference<Trip>;
export const viewsCol = db.collection('views').withConverter(typed<View>()) as CollectionReference<View>;
export const lineConfigRef = db.doc('config/line').withConverter(typed<LineConfig>()) as DocumentReference<LineConfig>;
export const usersCol = db.collection('users').withConverter(typed<User>()) as CollectionReference<User>;
export const apiKeysCol = db.collection('apiKeys').withConverter(typed<ApiKey>()) as CollectionReference<ApiKey>;
export const groupsCol = db.collection('groups').withConverter(typed<GroupBinding>()) as CollectionReference<GroupBinding>;
export const bindCodesCol = db.collection('bindCodes').withConverter(typed<BindCode>()) as CollectionReference<BindCode>;
export const pendingPhotosCol = db.collection('pendingPhotos').withConverter(typed<PendingPhoto>()) as CollectionReference<PendingPhoto>;

export function checkinsCol(tripId: string): CollectionReference<Checkin> {
  return tripsCol.doc(tripId).collection('checkins').withConverter(typed<Checkin>()) as CollectionReference<Checkin>;
}

export type TripSnap = QueryDocumentSnapshot<Trip>;

export async function getLineConfig(): Promise<LineConfig> {
  const snap = await lineConfigRef.get();
  const d = snap.data();
  return { monthKey: d?.monthKey ?? '', pushCount: d?.pushCount ?? 0 };
}

/** 擁有者目前綁定的群組 ID（無則 null）。 */
export async function groupIdForOwner(uid: string): Promise<string | null> {
  const q = await groupsCol.where('ownerUid', '==', uid).limit(1).get();
  return q.empty ? null : q.docs[0].id;
}
