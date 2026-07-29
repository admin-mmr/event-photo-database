/**
 * uploadDb.ts — tiny IndexedDB store for in-flight resumable upload sessions.
 *
 * This is what turns "closing the tab loses everything" into "we pick up where
 * you left off." For each file we persist its upload session URL keyed by a
 * stable fingerprint (token + name + size + lastModified). When the volunteer
 * reopens the page and re-selects the same files, resumableUpload looks the key
 * up, asks the bucket how many bytes were committed, and continues from there
 * instead of restarting.
 *
 * A session is good for ~7 days on both providers (GCS keeps an unfinalized
 * resumable upload that long; Azure garbage-collects uncommitted blocks after a
 * week), so we expire local records after 7 days to avoid resuming against a
 * dead URL.
 */

const DB_NAME = 'volunteer-uploads';
const STORE = 'sessions';
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface StoredSession {
  /** Fingerprint key (see sessionKey). */
  key: string;
  uploadId: string;
  objectName: string;
  sessionUri: string;
  batchId: string;
  total: number;
  createdAt: number;
  /** Wire protocol for `sessionUri`. Absent on records written by an older
   *  bundle, which were all GCS — `resumableUpload` defaults accordingly. */
  protocol?: 'gcs-resumable' | 'azure-block-blob';
  /** Metadata the client must stamp at commit time (Azure only; see the api's
   *  CreateUploadSessionResponse). Absent/empty means the session carries it. */
  metadata?: Record<string, string>;
}

/** Stable per-file key. lastModified + size make accidental re-selection of a
 *  different file with the same name resolve to a different key. */
export function sessionKey(token: string, file: File): string {
  return `${token}::${file.name}::${file.size}::${file.lastModified}`;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        t.oncomplete = () => db.close();
      }),
  );
}

export async function getSession(key: string): Promise<StoredSession | undefined> {
  try {
    const rec = (await tx<StoredSession | undefined>('readonly', (s) => s.get(key))) ?? undefined;
    if (rec && Date.now() - rec.createdAt > TTL_MS) {
      await deleteSession(key);
      return undefined;
    }
    return rec;
  } catch {
    // IndexedDB unavailable (private mode, etc.) — degrade to no-resume.
    return undefined;
  }
}

export async function putSession(rec: StoredSession): Promise<void> {
  try {
    await tx('readwrite', (s) => s.put(rec));
  } catch {
    /* best-effort persistence; a failure just means no resume */
  }
}

export async function deleteSession(key: string): Promise<void> {
  try {
    await tx('readwrite', (s) => s.delete(key));
  } catch {
    /* ignore */
  }
}
