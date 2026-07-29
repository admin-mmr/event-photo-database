/**
 * fakeObjectStore.test.ts — the shared in-memory ObjectStore against the
 * contract every adapter must satisfy.
 *
 * These cases are also the GCS adapter's spec: `gcsStore.ts` is pure delegation
 * to a client we do not re-test, so what pins its behaviour is this contract
 * plus the fact that the fake and the Blob adapter both pass it.
 */

import { describe, it, expect } from 'vitest';

import { attachmentDisposition } from '../src/lib/storage/disposition.js';
import { FakeObjectStore } from './helpers/fakeObjectStore.js';
import { runObjectStoreContract, type ObjectStoreHarness } from './helpers/objectStoreContract.js';

function harness(): ObjectStoreHarness {
  const store = new FakeObjectStore();
  return {
    store,
    seed: (bucket, key, opts) => void store.seed(bucket, key, opts ?? {}),
    keys: (bucket) => store.keys(bucket),
    has: (bucket, key) => store.has(bucket, key),
  };
}

runObjectStoreContract('FakeObjectStore', harness);

describe('attachmentDisposition', () => {
  it('is empty when there is no filename, so the URL serves inline', () => {
    expect(attachmentDisposition(undefined)).toBe('');
    expect(attachmentDisposition('')).toBe('');
    expect(attachmentDisposition('   ')).toBe('');
  });

  it('encodes as RFC-5987 UTF-8, which is what makes Chinese filenames work', () => {
    // A bare `filename=` is latin-1 only, and event photos routinely carry
    // Chinese names — this is the whole reason for the `filename*` form.
    expect(attachmentDisposition('湘舍动.jpg')).toBe(
      "attachment; filename*=UTF-8''%E6%B9%98%E8%88%8D%E5%8A%A8.jpg",
    );
  });

  it('escapes the characters encodeURIComponent leaves behind', () => {
    // ' and * survive encodeURIComponent but would terminate or quote the
    // filename* token. (The `filename*=` marker itself is the only `*` left.)
    const out = attachmentDisposition("it's (a) *photo*.jpg");
    expect(out).toBe("attachment; filename*=UTF-8''it%27s%20%28a%29%20%2Aphoto%2A.jpg");
  });

  it('does not double-encode a name that arrives already percent-encoded', () => {
    // Guard on the bug this function exists to prevent: routes/download.ts used
    // to call encodeURIComponent itself, so moving the encoding here had to come
    // with the call sites passing RAW names. A '%' is escaped to '%25' — if a
    // caller regresses, the volunteer sees the mangling immediately rather than
    // it silently looking plausible.
    expect(attachmentDisposition('%E6%B9%98.jpg')).toContain('%25E6%25B9%2598');
  });
});

describe('FakeObjectStore — test-double behaviour', () => {
  it('models a GCS session as server-pinned metadata the client never sends', async () => {
    const store = new FakeObjectStore();
    await store.createUploadSession('staging', 'vol/e1/b1/u1.jpg', {
      contentType: 'image/jpeg',
      metadata: { originalName: 'IMG_1.jpg', photographerName: 'Jane' },
      ttlMs: 1000,
    });
    // The object exists with its metadata before a single byte is PUT.
    expect((await store.head('staging', 'vol/e1/b1/u1.jpg'))?.custom).toEqual({
      originalName: 'IMG_1.jpg',
      photographerName: 'Jane',
    });
  });

  it('models the Azure session as client-stamped, so nothing exists yet', async () => {
    const store = new FakeObjectStore();
    store.protocol = 'azure-block-blob';
    const s = await store.createUploadSession('staging', 'vol/e1/b1/u1.jpg', {
      contentType: 'image/jpeg',
      metadata: { originalName: 'IMG_1.jpg' },
      ttlMs: 1000,
    });
    expect(s.clientStampsMetadata).toBe(true);
    expect(await store.head('staging', 'vol/e1/b1/u1.jpg')).toBeNull();
  });

  it('records removals only for objects that were actually there', async () => {
    const store = new FakeObjectStore();
    store.seed('b', 'a.jpg', { body: 'x' });
    await store.remove('b', 'a.jpg');
    await store.remove('b', 'a.jpg');
    expect(store.removed).toEqual(['a.jpg']);
  });
});
