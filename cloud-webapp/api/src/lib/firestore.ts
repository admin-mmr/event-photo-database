/**
 * firestore.ts — the app's single database handle.
 *
 * Returns a provider-neutral `DocumentStore` (see `lib/db/types.ts`), selected
 * by `CLOUD_PROVIDER`. The name is kept as `firestore()` so the ~31 modules
 * that call it are unchanged by AZ2; read it as "the document store", not "the
 * Firestore client". Nothing outside `lib/db/` may import
 * `@google-cloud/firestore`.
 */

import { env } from './config.js';
import { createFirestoreStore } from './db/firestoreDb.js';
import type { DocumentStore } from './db/types.js';

let _store: DocumentStore | null = null;

/**
 * Connect the store. Call once at startup, BEFORE serving traffic.
 *
 * Only Azure needs this: the Cosmos client is behind a dynamic `import()` (so
 * the GCP image never loads the Azure SDK), and that can't happen inside the
 * synchronous `firestore()`. On GCP this is a no-op — the Firestore client
 * constructs lazily, exactly as before.
 */
export async function initDb(): Promise<void> {
  if (_store) return;
  if (env.CLOUD_PROVIDER !== 'azure') return;
  const { createCosmosStore } = await import('./db/cosmosDb.js');
  _store = await createCosmosStore({
    endpoint: env.COSMOS_ENDPOINT ?? '',
    databaseId: env.COSMOS_DATABASE,
    key: env.COSMOS_KEY,
  });
}

export function firestore(): DocumentStore {
  if (_store) return _store;
  if (env.CLOUD_PROVIDER === 'azure') {
    // Reaching here means someone served a request before initDb() resolved.
    // Failing loudly beats a half-initialized store answering queries.
    throw new Error('CLOUD_PROVIDER=azure: initDb() must be awaited before firestore()');
  }
  _store = createFirestoreStore(env.GCP_PROJECT_ID || undefined);
  return _store;
}

/** Test seam: install a fake store (see `api/test/helpers/fakeDb.ts`). */
export function __setStoreForTests(store: DocumentStore | null): void {
  _store = store;
}

export type { DocumentStore } from './db/types.js';
