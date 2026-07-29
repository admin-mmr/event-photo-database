/**
 * objectStoreContract.ts — the ObjectStore contract, once, run against every
 * adapter.
 *
 * These are the semantics the app depends on. `test/fakeObjectStore.test.ts`
 * runs them against the shared in-memory fake; `test/blobStore.test.ts` runs the
 * SAME cases against the Azure adapter (over `fakeBlobService.ts`). When the two
 * disagree, one of them is a bug.
 *
 * Each case names the caller that depends on it, because "the interface says so"
 * is not a reason to keep a behaviour — a real call site is.
 */

import { describe, it, expect } from 'vitest';

import type { ObjectStore } from '../../src/lib/storage/types.js';

/**
 * What a backend must provide to be run against this suite: the store, plus
 * out-of-band seed/inspect access so assertions check what was actually
 * persisted rather than trusting the store's own reads.
 */
export interface ObjectStoreHarness {
  store: ObjectStore;
  /** Put an object there without going through the store. */
  seed(
    bucket: string,
    key: string,
    opts?: { body?: Buffer | string; contentType?: string; md5Hex?: string; custom?: Record<string, string> },
  ): void;
  keys(bucket: string): string[];
  has(bucket: string, key: string): boolean;
}

export function runObjectStoreContract(label: string, makeHarness: () => ObjectStoreHarness): void {
  const B = 'derivatives';

  describe(`${label} — head`, () => {
    it('returns null for a missing object rather than throwing', async () => {
      // enqueueStagedBatch's "staged object missing, skipping" branch. A throw
      // here would abort the whole batch instead of skipping one file.
      const h = makeHarness();
      expect(await h.store.head(B, 'nope.jpg')).toBeNull();
    });

    it('reports size, content type, md5 hex and custom metadata', async () => {
      const h = makeHarness();
      h.seed(B, 'a.jpg', {
        body: 'hello',
        contentType: 'image/jpeg',
        custom: { originalName: 'IMG_1.jpg', photographerName: 'Jane' },
      });
      const meta = await h.store.head(B, 'a.jpg');
      expect(meta).toMatchObject({
        size: 5,
        contentType: 'image/jpeg',
        // md5('hello')
        md5Hex: '5d41402abc4b2a76b9719d911017c592',
        custom: { originalName: 'IMG_1.jpg', photographerName: 'Jane' },
      });
    });

    it('reports an absent hash as the empty string, not a fake one', async () => {
      // '' means UNKNOWN. enqueueStagedBatch falls back to the name+size dedup
      // key on it; treating unknown as "no match" is what loses photos.
      const h = makeHarness();
      h.seed(B, 'a.jpg', { body: 'hello', md5Hex: '' });
      expect((await h.store.head(B, 'a.jpg'))?.md5Hex).toBe('');
    });

    it('defaults a missing content type instead of returning empty', async () => {
      const h = makeHarness();
      h.seed(B, 'a.bin', { body: 'x', contentType: '' });
      expect((await h.store.head(B, 'a.bin'))?.contentType).toBe('application/octet-stream');
    });
  });

  describe(`${label} — read`, () => {
    it('returns the whole object', async () => {
      const h = makeHarness();
      h.seed(B, 'a.jpg', { body: 'abcdefghij' });
      expect((await h.store.read(B, 'a.jpg')).toString()).toBe('abcdefghij');
    });

    it('treats a range as INCLUSIVE on both ends', async () => {
      // The chunked staging→Drive copy of a large video asks for
      // { start, end } and expects end-start+1 bytes. Off by one here and every
      // video lands truncated by a byte per chunk.
      const h = makeHarness();
      h.seed(B, 'a.mp4', { body: 'abcdefghij' });
      expect((await h.store.read(B, 'a.mp4', { start: 0, end: 3 })).toString()).toBe('abcd');
      expect((await h.store.read(B, 'a.mp4', { start: 4, end: 9 })).toString()).toBe('efghij');
    });
  });

  describe(`${label} — write`, () => {
    it('round-trips bytes and content type', async () => {
      // uploadReference storing a searcher's selfie.
      const h = makeHarness();
      await h.store.write('uploads', 'find_me_references/u1/x.jpg', Buffer.from('selfie'), {
        contentType: 'image/jpeg',
      });
      const meta = await h.store.head('uploads', 'find_me_references/u1/x.jpg');
      expect(meta?.contentType).toBe('image/jpeg');
      expect((await h.store.read('uploads', 'find_me_references/u1/x.jpg')).toString()).toBe('selfie');
    });
  });

  describe(`${label} — remove`, () => {
    it('deletes an object', async () => {
      const h = makeHarness();
      h.seed(B, 'a.jpg', { body: 'x' });
      await h.store.remove(B, 'a.jpg');
      expect(h.has(B, 'a.jpg')).toBe(false);
    });

    it('is a NO-OP on a missing object', async () => {
      // deletePhotoDerivatives deletes orig+web+thumb unconditionally, and a
      // partially-indexed photo has no web/thumb yet. A re-delete must also be
      // harmless — event deletion re-runs itself after a deadline cut.
      const h = makeHarness();
      await expect(h.store.remove(B, 'never-existed.jpg')).resolves.toBeUndefined();
    });
  });

  describe(`${label} — list`, () => {
    it('filters by prefix and orders by key', async () => {
      const h = makeHarness();
      h.seed(B, 'e2/photos/thumb/z.jpg');
      h.seed(B, 'e1/photos/thumb/b.jpg');
      h.seed(B, 'e1/photos/thumb/a.jpg');
      const keys = (await h.store.list(B, { prefix: 'e1/' })).map((o) => o.key);
      expect(keys).toEqual(['e1/photos/thumb/a.jpg', 'e1/photos/thumb/b.jpg']);
    });

    it('honours limit', async () => {
      // countUnderPrefix asks for cap+1 and infers "capped" from getting cap+1
      // back, so a limit that over-delivers turns an exact count into a lie.
      const h = makeHarness();
      for (const n of ['a', 'b', 'c', 'd']) h.seed(B, `e1/${n}`);
      expect(await h.store.list(B, { prefix: 'e1/', limit: 2 })).toHaveLength(2);
      expect(await h.store.list(B, { prefix: 'e1/', limit: 99 })).toHaveLength(4);
    });

    it('returns metadata with each entry', async () => {
      // uploadRecoveryService.listStaged reads md5/size/custom straight off the
      // listing; a second head() per object would be a round trip per staged
      // photo, and there were 2,289 of them on 2026-07-28.
      const h = makeHarness();
      h.seed(B, 'e1/a.jpg', { body: 'hello', custom: { linkId: 'link-1' } });
      const [entry] = await h.store.list(B, { prefix: 'e1/' });
      expect(entry?.metadata.size).toBe(5);
      expect(entry?.metadata.md5Hex).toBe('5d41402abc4b2a76b9719d911017c592');
      expect(entry?.metadata.custom.linkId).toBe('link-1');
    });

    it('is empty, not an error, for a prefix with nothing under it', async () => {
      const h = makeHarness();
      expect(await h.store.list(B, { prefix: 'gone/' })).toEqual([]);
    });
  });

  describe(`${label} — signReadUrl`, () => {
    it('returns an absolute URL', async () => {
      const h = makeHarness();
      h.seed(B, 'e1/photos/thumb/p1.jpg');
      const url = await h.store.signReadUrl(B, 'e1/photos/thumb/p1.jpg', { ttlMs: 60_000 });
      expect(url).toMatch(/^https:\/\//);
    });

    it('signs an object that does not exist yet', async () => {
      // The gallery signs a thumb URL per photo from the Firestore cache without
      // checking the bucket; a not-yet-derived photo must yield a URL (which
      // 404s on fetch), not an exception that fails the whole page.
      const h = makeHarness();
      await expect(
        h.store.signReadUrl(B, 'e1/photos/thumb/unindexed.jpg', { ttlMs: 60_000 }),
      ).resolves.toMatch(/^https:\/\//);
    });
  });

  describe(`${label} — createUploadSession`, () => {
    it('returns a URL and names the protocol the client must speak', async () => {
      const h = makeHarness();
      const s = await h.store.createUploadSession('staging', 'vol/e1/b1/u1.jpg', {
        contentType: 'image/jpeg',
        metadata: { eventId: 'e1' },
        ttlMs: 3600_000,
      });
      expect(s.url).toMatch(/^https:\/\//);
      expect(['gcs-resumable', 'azure-block-blob']).toContain(s.protocol);
      expect(typeof s.clientStampsMetadata).toBe('boolean');
    });

    it('scopes the session to the requested key', async () => {
      // The volunteer flow is unauthenticated: this credential is all the
      // browser gets, so it must not be usable anywhere else in the bucket.
      const h = makeHarness();
      const s = await h.store.createUploadSession('staging', 'vol/e1/b1/u1.jpg', {
        contentType: 'image/jpeg',
        metadata: {},
        ttlMs: 3600_000,
      });
      expect(s.url).toContain('vol/e1/b1/u1.jpg');
    });
  });
}
