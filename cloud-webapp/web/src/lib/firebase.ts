/**
 * firebase.ts — Firebase app/auth bootstrap.
 *
 * Config comes from Firebase Hosting's reserved URL `/__/firebase/init.json`
 * (served automatically on *.web.app and custom domains — no secrets in the
 * repo). For local dev, either let Vite proxy `/__` to the live site (see
 * vite.config.ts) or set VITE_FIREBASE_CONFIG to the JSON from
 * `firebase apps:sdkconfig WEB`.
 */

import { initializeApp, type FirebaseOptions } from 'firebase/app';
import type { FirebaseError } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  linkWithPopup,
  onAuthStateChanged,
  signInAnonymously,
  signInWithCredential,
  signInWithPopup,
  signOut,
  type Auth,
  type User,
} from 'firebase/auth';

let authPromise: Promise<Auth> | null = null;

async function loadConfig(): Promise<FirebaseOptions> {
  try {
    const res = await fetch('/__/firebase/init.json');
    if (res.ok) return (await res.json()) as FirebaseOptions;
  } catch {
    // fall through to env config
  }
  const raw = import.meta.env.VITE_FIREBASE_CONFIG as string | undefined;
  if (raw) return JSON.parse(raw) as FirebaseOptions;
  throw new Error(
    'Firebase config unavailable — /__/firebase/init.json not served and VITE_FIREBASE_CONFIG unset',
  );
}

export function firebaseAuth(): Promise<Auth> {
  if (authPromise === null) {
    authPromise = loadConfig().then((cfg) => getAuth(initializeApp(cfg)));
  }
  return authPromise;
}

export async function signInWithGoogle(): Promise<void> {
  const auth = await firebaseAuth();
  await signInWithPopup(auth, new GoogleAuthProvider());
}

/**
 * Turn the current GUEST into a Google account, keeping the same uid where
 * possible — used when a bot check (reCAPTCHA or the per-IP guest limit)
 * blocks a guest. Google-signed-in users are exempt from both checks on the
 * api (api/src/lib/signIn.ts), so this is the one-tap way past a false
 * positive.
 *
 * linkWithPopup, not signInWithPopup: linking keeps the anonymous uid, so the
 * guest's consent record, saved selfies and "delete my data" all stay theirs.
 * If that Google account already exists (it was used here before), linking
 * fails with credential-already-in-use and we sign in to it instead — a
 * different uid, which is unavoidable and is just a normal Google sign-in.
 * The token is force-refreshed so the very next api call carries the Google
 * identity.
 */
export async function upgradeGuestToGoogle(): Promise<'linked' | 'signed_in'> {
  const auth = await firebaseAuth();
  const provider = new GoogleAuthProvider();
  const user = auth.currentUser;
  if (!user || !user.isAnonymous) {
    await signInWithPopup(auth, provider);
    return 'signed_in';
  }
  try {
    await linkWithPopup(user, provider);
    await user.getIdToken(true);
    return 'linked';
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code !== 'auth/credential-already-in-use' && code !== 'auth/email-already-in-use') throw err;
    const credential = GoogleAuthProvider.credentialFromError(err as FirebaseError);
    if (credential) await signInWithCredential(auth, credential);
    else await signInWithPopup(auth, provider);
    return 'signed_in';
  }
}

/**
 * Continue as a guest — a Firebase anonymous session. The user gets a real uid
 * (so consent records, per-user rate limits, reference-selfie reuse, and
 * "delete my data" all keep working) but no email, so admin routes stay closed.
 *
 * Requires Anonymous sign-in to be enabled in the Firebase console
 * (Authentication → Sign-in method → Anonymous). If it isn't, this rejects with
 * `auth/operation-not-allowed` / `auth/admin-restricted-operation`.
 */
export async function continueAsGuest(): Promise<void> {
  const auth = await firebaseAuth();
  await signInAnonymously(auth);
}

export async function signOutUser(): Promise<void> {
  await signOut(await firebaseAuth());
}

/** Subscribe to auth state. Returns an unsubscribe function. */
export function watchAuth(cb: (user: User | null) => void): () => void {
  let unsub: (() => void) | null = null;
  let cancelled = false;
  firebaseAuth()
    .then((auth) => {
      if (cancelled) return;
      unsub = onAuthStateChanged(auth, cb);
    })
    .catch((err: unknown) => {
      console.error('firebase init failed', err);
      cb(null);
    });
  return () => {
    cancelled = true;
    unsub?.();
  };
}

/** Current user's ID token, or null when signed out. */
export async function idToken(): Promise<string | null> {
  const auth = await firebaseAuth();
  return auth.currentUser ? auth.currentUser.getIdToken() : null;
}
