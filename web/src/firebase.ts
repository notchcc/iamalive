import { getApps, initializeApp, type FirebaseApp } from 'firebase/app';
import { getFirestore, type Firestore } from 'firebase/firestore';

let app: FirebaseApp | null = null;

export function firebaseApp(): FirebaseApp {
  if (app) return app;
  const cfg = {
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY as string,
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN as string,
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID as string,
    appId: import.meta.env.VITE_FIREBASE_APP_ID as string,
  };
  app = getApps()[0] ?? initializeApp(cfg);
  return app;
}

export function firestore(): Firestore {
  return getFirestore(firebaseApp());
}
