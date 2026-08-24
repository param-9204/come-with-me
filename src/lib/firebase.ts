import { getApps, initializeApp, cert } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';

let appInitialized = false;

if (getApps().length === 0) {
  try {
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    // Replace standard escaped newline chars from env with actual newlines
    const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

    if (!projectId || !clientEmail || !privateKey) {
      console.warn('[Firebase Admin] Missing credentials in environment. Firebase notifications will be disabled.');
    } else {
      initializeApp({
        credential: cert({
          projectId,
          clientEmail,
          privateKey,
        }),
      });
      appInitialized = true;
      console.log('[Firebase Admin] Initialized successfully');
    }
  } catch (error: any) {
    console.error('[Firebase Admin] Initialization failed:', error.message);
  }
} else {
  appInitialized = true;
}

export const messaging = appInitialized ? getMessaging() : null;
