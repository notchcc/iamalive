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
import type { Checkin, LineConfig, Trip, View } from './types.js';

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

export function checkinsCol(tripId: string): CollectionReference<Checkin> {
  return tripsCol.doc(tripId).collection('checkins').withConverter(typed<Checkin>()) as CollectionReference<Checkin>;
}

export type TripSnap = QueryDocumentSnapshot<Trip>;

export async function getLineConfig(): Promise<LineConfig> {
  const snap = await lineConfigRef.get();
  return (
    snap.data() ?? {
      groupId: null,
      joinedAt: null,
      monthKey: '',
      pushCount: 0,
    }
  );
}
