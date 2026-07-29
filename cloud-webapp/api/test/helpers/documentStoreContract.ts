/**
 * documentStoreContract.ts — the DocumentStore contract, once, run against
 * every adapter.
 *
 * These are the semantics the app depends on. `test/fakeDb.test.ts` runs them
 * against the shared in-memory fake; `test/cosmosDb.test.ts` runs the SAME cases
 * against the Cosmos adapter (over `fakeCosmos.ts`). When the two disagree, one
 * of them is a bug — which is the entire point of writing it this way rather
 * than letting each backend carry its own bespoke assertions.
 *
 * Each case names the caller that depends on it.
 */

import { describe, it, expect } from 'vitest';

import { DOC_ID, type DocData, type DocumentStore } from '../../src/lib/db/types.js';

/**
 * What a backend must provide to be run against this suite: the store itself,
 * plus out-of-band seed/inspect access so assertions can check what was actually
 * persisted rather than trusting the store's own reads.
 */
export interface StoreHarness {
  store: DocumentStore;
  seed(collection: string, docs: Record<string, DocData>): void;
  peek(collection: string, id: string): DocData | undefined;
  ids(collection: string): string[];
  transactions(): number;
}

export function runDocumentStoreContract(label: string, makeHarness: () => StoreHarness): void {
  describe(`${label} — writes`, () => {
    it('set replaces the whole document; set+merge keeps unlisted fields', async () => {
      const h = makeHarness();
      const ref = h.store.collection('events').doc('e1');
      await ref.set({ name: 'Regatta', status: 'active' });
      await ref.set({ name: 'Regatta 2' });
      expect(h.peek('events', 'e1')).toEqual({ name: 'Regatta 2' });

      await ref.set({ status: 'archived' }, { merge: true });
      expect(h.peek('events', 'e1')).toEqual({ name: 'Regatta 2', status: 'archived' });
    });

    it('create fails when the document exists', async () => {
      // uploadDedupService claims an md5 with create(); the rejection IS the
      // "someone else already owns these bytes" signal that prevents duplicates.
      const h = makeHarness();
      const ref = h.store.collection('upload_dedup').doc('md5abc');
      await ref.create({ owner: 'batch1' });
      await expect(ref.create({ owner: 'batch2' })).rejects.toThrow(/ALREADY_EXISTS/);
      expect(h.peek('upload_dedup', 'md5abc')).toEqual({ owner: 'batch1' });
    });

    it('update fails when the document does not exist', async () => {
      const h = makeHarness();
      await expect(h.store.collection('events').doc('nope').update({ a: 1 })).rejects.toThrow(
        /NOT_FOUND/,
      );
    });

    it('update merges rather than replacing', async () => {
      const h = makeHarness();
      const ref = h.store.collection('events').doc('e1');
      await ref.set({ name: 'Regatta', status: 'active' });
      await ref.update({ status: 'archived' });
      expect(h.peek('events', 'e1')).toEqual({ name: 'Regatta', status: 'archived' });
    });

    it('add generates an id and returns a usable ref', async () => {
      const h = makeHarness();
      const ref = await h.store.collection('consents').add({ action: 'findme_search' });
      expect(ref.id).toBeTruthy();
      expect((await ref.get()).data()).toEqual({ action: 'findme_search' });
    });

    it('delete removes the document and is a no-op when absent', async () => {
      const h = makeHarness();
      await h.store.collection('events').doc('e1').set({ a: 1 });
      await h.store.collection('events').doc('e1').delete();
      expect(h.peek('events', 'e1')).toBeUndefined();
      await expect(h.store.collection('events').doc('ghost').delete()).resolves.toBeUndefined();
    });

    it('reads are isolated, so a caller cannot mutate the store', async () => {
      const h = makeHarness();
      h.seed('events', { e1: { tags: ['a'] } });
      const body = (await h.store.collection('events').doc('e1').get()).data();
      (body as { tags: string[] }).tags.push('b');
      expect(h.peek('events', 'e1')).toEqual({ tags: ['a'] });
    });
  });

  describe(`${label} — queries`, () => {
    const seeded = (h: StoreHarness): StoreHarness => {
      h.seed('photos', {
        p3: { eventId: 'e1', name: 'c.jpg', takenAt: '2026-03-01' },
        p1: { eventId: 'e1', name: 'a.jpg', takenAt: '2026-01-01' },
        p2: { eventId: 'e1', name: 'b.jpg', takenAt: '2026-02-01' },
        p4: { eventId: 'e2', name: 'd.jpg', takenAt: '2026-04-01' },
      });
      return h;
    };

    it('filters by equality and orders ascending/descending', async () => {
      const h = seeded(makeHarness());
      const asc = await h.store
        .collection('photos')
        .where('eventId', '==', 'e1')
        .orderBy('takenAt')
        .get();
      expect(asc.docs.map((d) => d.id)).toEqual(['p1', 'p2', 'p3']);

      const desc = await h.store
        .collection('photos')
        .where('eventId', '==', 'e1')
        .orderBy('takenAt', 'desc')
        .get();
      expect(desc.docs.map((d) => d.id)).toEqual(['p3', 'p2', 'p1']);
    });

    it('EXCLUDES documents missing an orderBy field', async () => {
      // This is why gallery.ts has an addedAt→takenAt fallback: an event indexed
      // before `addedAt` existed returns an empty page rather than unsorted rows.
      // On Cosmos this only holds because of the IS_DEFINED guard in cosmosSql.
      const h = seeded(makeHarness());
      h.seed('photos', { p5: { eventId: 'e1', name: 'e.jpg' } });
      const snap = await h.store
        .collection('photos')
        .where('eventId', '==', 'e1')
        .orderBy('takenAt')
        .get();
      expect(snap.docs.map((d) => d.id)).not.toContain('p5');
      expect(snap.size).toBe(3);
    });

    it('paginates with limit + startAfter on (field, DOC_ID)', async () => {
      // The gallery's page contract: the id tiebreak makes the sequence total, so
      // photos sharing a takenAt cannot be skipped or repeated across pages.
      const h = seeded(makeHarness());
      const page = (after?: [string, string]) => {
        let q = h.store
          .collection('photos')
          .where('eventId', '==', 'e1')
          .orderBy('takenAt', 'asc')
          .orderBy(DOC_ID, 'asc');
        if (after) q = q.startAfter(...after);
        return q.limit(2).get();
      };

      const first = await page();
      expect(first.docs.map((d) => d.id)).toEqual(['p1', 'p2']);

      const last = first.docs[first.docs.length - 1]!;
      const second = await page([last.data().takenAt as string, last.id]);
      expect(second.docs.map((d) => d.id)).toEqual(['p3']);

      const third = await page(['2026-03-01', 'p3']);
      expect(third.empty).toBe(true);
    });

    it('paginates descending too', async () => {
      // Direction flips the keyset comparison; getting it wrong silently returns
      // the first page forever.
      const h = seeded(makeHarness());
      const first = await h.store
        .collection('photos')
        .where('eventId', '==', 'e1')
        .orderBy('takenAt', 'desc')
        .orderBy(DOC_ID, 'desc')
        .limit(2)
        .get();
      expect(first.docs.map((d) => d.id)).toEqual(['p3', 'p2']);

      const second = await h.store
        .collection('photos')
        .where('eventId', '==', 'e1')
        .orderBy('takenAt', 'desc')
        .orderBy(DOC_ID, 'desc')
        .startAfter('2026-02-01', 'p2')
        .limit(2)
        .get();
      expect(second.docs.map((d) => d.id)).toEqual(['p1']);
    });

    it('startAfter excludes the cursor document itself', async () => {
      const h = seeded(makeHarness());
      const snap = await h.store
        .collection('photos')
        .where('eventId', '==', 'e1')
        .orderBy('takenAt')
        .orderBy(DOC_ID)
        .startAfter('2026-01-01', 'p1')
        .get();
      expect(snap.docs.map((d) => d.id)).toEqual(['p2', 'p3']);
    });

    it('ties on the ordered field are broken by document id', async () => {
      const h = makeHarness();
      h.seed('photos', {
        b: { eventId: 'e1', takenAt: 'same' },
        a: { eventId: 'e1', takenAt: 'same' },
        c: { eventId: 'e1', takenAt: 'same' },
      });
      const snap = await h.store
        .collection('photos')
        .where('eventId', '==', 'e1')
        .orderBy('takenAt')
        .orderBy(DOC_ID)
        .get();
      expect(snap.docs.map((d) => d.id)).toEqual(['a', 'b', 'c']);
    });

    it('a tied page boundary neither skips nor repeats', async () => {
      // The reason the id tiebreak exists at all.
      const h = makeHarness();
      h.seed('photos', {
        a: { eventId: 'e1', takenAt: 'same' },
        b: { eventId: 'e1', takenAt: 'same' },
        c: { eventId: 'e1', takenAt: 'same' },
        d: { eventId: 'e1', takenAt: 'same' },
      });
      const q = () =>
        h.store.collection('photos').where('eventId', '==', 'e1').orderBy('takenAt').orderBy(DOC_ID);

      const p1 = await q().limit(2).get();
      const p2 = await q().startAfter('same', 'b').limit(2).get();
      expect(p1.docs.map((d) => d.id)).toEqual(['a', 'b']);
      expect(p2.docs.map((d) => d.id)).toEqual(['c', 'd']);
    });

    it('select projects fields; select() with no args yields ids only', async () => {
      // eventDeletionService uses bare select() to enumerate ids for deletion.
      const h = seeded(makeHarness());
      const projected = await h.store
        .collection('photos')
        .where('eventId', '==', 'e1')
        .orderBy('name')
        .select('name')
        .get();
      expect(projected.docs.map((d) => d.data())).toEqual([
        { name: 'a.jpg' },
        { name: 'b.jpg' },
        { name: 'c.jpg' },
      ]);

      const idsOnly = await h.store
        .collection('photos')
        .where('eventId', '==', 'e1')
        .orderBy('name')
        .select()
        .get();
      expect(idsOnly.docs.map((d) => d.data())).toEqual([{}, {}, {}]);
      expect(idsOnly.docs.map((d) => d.id)).toEqual(['p1', 'p2', 'p3']);
    });

    it('count() respects the filters', async () => {
      const h = seeded(makeHarness());
      const all = await h.store.collection('photos').count().get();
      expect(all.data().count).toBe(4);
      const scoped = await h.store.collection('photos').where('eventId', '==', 'e1').count().get();
      expect(scoped.data().count).toBe(3);
    });

    it('snapshot.get(field) reads a single field', async () => {
      // folderRebuildQueue / duplicateRemovalQueue read lease fields this way.
      const h = seeded(makeHarness());
      const snap = await h.store.collection('photos').doc('p1').get();
      expect(snap.get('name')).toBe('a.jpg');
      expect(snap.get('missing')).toBeUndefined();
    });

    it('a missing document reports exists=false and undefined data', async () => {
      const h = makeHarness();
      const snap = await h.store.collection('events').doc('ghost').get();
      expect(snap.exists).toBe(false);
      expect(snap.data()).toBeUndefined();
      expect(snap.id).toBe('ghost');
    });

    it('the document id is not part of the body', async () => {
      // Cosmos stores `id` inside the document; Firestore does not. Callers do
      // `{ id: snap.id, ...snap.data() }`, so a leaked `id` would be invisible
      // there and wrong everywhere else.
      const h = makeHarness();
      await h.store.collection('events').doc('e1').set({ name: 'Regatta' });
      const snap = await h.store.collection('events').doc('e1').get();
      expect(snap.data()).toEqual({ name: 'Regatta' });
      expect(snap.id).toBe('e1');
    });
  });

  describe(`${label} — transactions and batches`, () => {
    it('a transaction sees its reads and applies its writes', async () => {
      const h = makeHarness();
      h.seed('rate_limits', { 'b:u1:0': { count: 4 } });
      const next = await h.store.runTransaction(async (tx) => {
        const ref = h.store.collection('rate_limits').doc('b:u1:0');
        const snap = await tx.get(ref);
        const n = ((snap.data()?.count as number | undefined) ?? 0) + 1;
        tx.set(ref, { count: n }, { merge: true });
        return n;
      });
      expect(next).toBe(5);
      expect(h.peek('rate_limits', 'b:u1:0')).toEqual({ count: 5 });
      expect(h.transactions()).toBe(1);
    });

    it('a transaction can create a document that did not exist', async () => {
      // The first request in a rate-limit window takes this path.
      const h = makeHarness();
      const value = await h.store.runTransaction(async (tx) => {
        const ref = h.store.collection('rate_limits').doc('b:u9:0');
        const snap = await tx.get(ref);
        expect(snap.exists).toBe(false);
        tx.set(ref, { count: 1 }, { merge: true });
        return 1;
      });
      expect(value).toBe(1);
      expect(h.peek('rate_limits', 'b:u9:0')).toEqual({ count: 1 });
    });

    it('rejects a read after a write, as Firestore does', async () => {
      // A transaction body that reads late works by accident on some backends
      // and fails in production; Cosmos needs the same ordering.
      const h = makeHarness();
      const ref = h.store.collection('events').doc('e1');
      await expect(
        h.store.runTransaction(async (tx) => {
          tx.set(ref, { a: 1 });
          await tx.get(ref);
        }),
      ).rejects.toThrow(/read after write/);
    });

    it('a transaction that throws propagates the error', async () => {
      const h = makeHarness();
      await expect(
        h.store.runTransaction(async () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
    });

    it('batch deletes apply on commit, not before', async () => {
      const h = makeHarness();
      h.seed('consents', { c1: { uid: 'u1' }, c2: { uid: 'u1' } });
      const batch = h.store.batch();
      batch.delete(h.store.collection('consents').doc('c1'));
      batch.delete(h.store.collection('consents').doc('c2'));
      expect(h.ids('consents')).toEqual(['c1', 'c2']);
      await batch.commit();
      expect(h.ids('consents')).toEqual([]);
    });
  });
}
