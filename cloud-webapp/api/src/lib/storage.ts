/**
 * storage.ts — the app's single object-store handle.
 *
 * The sibling of `lib/firestore.ts`. Returns a provider-neutral `ObjectStore`
 * (see `lib/storage/types.ts`), selected by `CLOUD_PROVIDER`. Nothing outside
 * `lib/storage/` may import `@google-cloud/storage` or `@azure/storage-blob`.
 */

import { env } from './config.js';
import { createGcsStore } from './storage/gcsStore.js';
import type { ObjectStore } from './storage/types.js';

let _store: ObjectStore | null = null;

/**
 * Connect the store. Call once at startup, BEFORE serving traffic.
 *
 * Only Azure needs this: the Blob client is behind a dynamic `import()` (so the
 * GCP image never loads the Azure SDK), and that can't happen inside the
 * synchronous `objectStore()`. On GCP this is a no-op — the GCS client
 * constructs lazily, exactly as before.
 */
export async function initStorage(): Promise<void> {
  if (_store) return;
  if (env.CLOUD_PROVIDER !== 'azure') return;
  const { createBlobStore } = await import('./storage/blobStore.js');
  _store = await createBlobStore({
    accountUrl: env.AZURE_STORAGE_ACCOUNT_URL ?? '',
    connectionString: env.AZURE_STORAGE_CONNECTION_STRING || undefined,
  });
}

export function objectStore(): ObjectStore {
  if (_store) return _store;
  if (env.CLOUD_PROVIDER === 'azure') {
    // Reaching here means someone served a request before initStorage()
    // resolved. Failing loudly beats a half-initialized store signing URLs.
    throw new Error('CLOUD_PROVIDER=azure: initStorage() must be awaited before objectStore()');
  }
  _store = createGcsStore(env.GCP_PROJECT_ID || undefined);
  return _store;
}

/** Test seam: install a fake store (see `api/test/helpers/fakeObjectStore.ts`). */
export function __setObjectStoreForTests(store: ObjectStore | null): void {
  _store = store;
}

export type { ObjectStore } from './storage/types.js';
