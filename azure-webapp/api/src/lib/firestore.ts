import { Firestore } from '@google-cloud/firestore';
import { env } from './config.js';

/**
 * Firestore client.
 *
 * On Cloud Run, authentication is via Application Default Credentials
 * picked up from the attached service account. Locally, run
 * `gcloud auth application-default login` once.
 *
 * Pass a `projectId` only if we can't rely on ADC's auto-detection
 * (e.g. running tests against the emulator).
 */
let _firestore: Firestore | null = null;

export function firestore(): Firestore {
  if (_firestore) return _firestore;
  _firestore = new Firestore(
    env.GCP_PROJECT_ID ? { projectId: env.GCP_PROJECT_ID } : {},
  );
  return _firestore;
}
