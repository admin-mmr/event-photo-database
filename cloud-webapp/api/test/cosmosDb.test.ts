/**
 * cosmosDb.test.ts — the Cosmos adapter against the SAME contract as the
 * Firestore-shaped fake, plus the behaviours that are Cosmos-specific.
 *
 * The store runs over `helpers/fakeCosmos.ts`, which executes the generated SQL
 * in memory. That covers translation and semantics; it cannot cover RU cost,
 * index requirements, or real cross-partition ORDER BY — those need the emulator
 * or a live account and stay an AZ4 item.
 */

import { describe, it, expect } from 'vitest';

import {
  ConflictError,
  CosmosStore,
  PARTITION_KEYS,
  PreconditionFailedError,
  decodeDocId,
  encodeDocId,
  partitionKeyPath,
  type CosmosOps,
} from '../src/lib/db/cosmosDb.js';
import { runDocumentStoreContract } from './helpers/documentStoreContract.js';
import { FakeCosmos, cosmosHarness } from './helpers/fakeCosmos.js';

runDocumentStoreContract('CosmosStore', cosmosHarness);

describe('Cosmos adapter — partition keys', () => {
  it('derives the partition key from the id only when the key path is /id', () => {
    expect(partitionKeyPath('events')).toBe('/id');
    expect(partitionKeyPath('photos')).toBe('/eventId');
    // Unlisted containers fall back to /id.
    expect(partitionKeyPath('something_new')).toBe('/id');
  });

  it('point-reads a /eventId-partitioned document without knowing the event', async () => {
    // The real constraint: gallery/download do collection('photos').doc(id).get()
    // with no eventId in hand. This must still find the document.
    const h = cosmosHarness();
    h.seed('photos', { p1: { eventId: 'e1', name: 'a.jpg' } });
    const snap = await h.store.collection('photos').doc('p1').get();
    expect(snap.exists).toBe(true);
    expect(snap.data()).toEqual({ eventId: 'e1', name: 'a.jpg' });
  });

  it('deletes a /eventId-partitioned document without knowing the event', async () => {
    const h = cosmosHarness();
    h.seed('photos', { p1: { eventId: 'e1' } });
    await h.store.collection('photos').doc('p1').delete();
    expect(h.peek('photos', 'p1')).toBeUndefined();
  });

  it('every collection the api uses has an explicit partition key', () => {
    // Guards against a new collection silently defaulting to /id when its
    // queries filter on something else — an RU cliff that only shows up in prod.
    const used = [
      'admin_audit', 'auditLog', 'clubs', 'consents', 'emailPrefs', 'events',
      'match_feedback', 'match_runs', 'photos', 'rate_limits', 'specialFolders',
      'uploadLinks', 'users', 'upload_batches', 'upload_dedup', 'find_me_uploads',
      'folderRebuildBatches', 'duplicateRemovalBatches',
    ];
    const missing = used.filter((c) => !(c in PARTITION_KEYS));
    expect(missing).toEqual([]);
  });
});

describe('Cosmos adapter — document ids', () => {
  it('round-trips ids containing characters Cosmos forbids', () => {
    for (const id of ['a/b', 'a\\b', 'a?b', 'a#b', 'plain-id', 'b:u1:1700000000']) {
      expect(decodeDocId(encodeDocId(id))).toBe(id);
    }
  });

  it('leaves ordinary ids untouched', () => {
    // Composite rate-limit ids and Drive file ids must not be rewritten.
    expect(encodeDocId('search:u1:1700000000')).toBe('search:u1:1700000000');
    expect(encodeDocId('1a2B_c-d')).toBe('1a2B_c-d');
  });

  it('exposes the decoded id on a snapshot', async () => {
    const h = cosmosHarness();
    await h.store.collection('events').doc('a#b').set({ n: 1 });
    const snap = await h.store.collection('events').doc('a#b').get();
    expect(snap.id).toBe('a#b');
    expect(snap.exists).toBe(true);
  });
});

describe('Cosmos adapter — optimistic concurrency', () => {
  /** Ops that fail the first write with the given error, then behave normally. */
  function flaky(base: CosmosOps, err: Error): CosmosOps {
    let thrown = false;
    return {
      ...base,
      readById: (c, i, p) => base.readById(c, i, p),
      query: (c, s) => base.query(c, s),
      remove: (c, i, p) => base.remove(c, i, p),
      upsert: async (c, b, m) => {
        if (!thrown) {
          thrown = true;
          throw err;
        }
        return base.upsert(c, b, m);
      },
      create: async (c, b) => {
        if (!thrown) {
          thrown = true;
          throw err;
        }
        return base.create(c, b);
      },
    };
  }

  it('retries a transaction when the ETag no longer matches', async () => {
    const ops = new FakeCosmos();
    const store = new CosmosStore(flaky(ops, new PreconditionFailedError('etag mismatch')));
    let bodyRuns = 0;

    const result = await store.runTransaction(async (tx) => {
      bodyRuns += 1;
      const ref = store.collection('rate_limits').doc('k');
      const snap = await tx.get(ref);
      const n = ((snap.data()?.count as number | undefined) ?? 0) + 1;
      tx.set(ref, { count: n }, { merge: true });
      return n;
    });

    // The body re-ran against fresh state rather than the write being lost.
    expect(bodyRuns).toBe(2);
    expect(result).toBe(1);
    expect(ops.containers.get('rate_limits')?.get('k')?.count).toBe(1);
  });

  it('retries when a concurrent writer created the document first', async () => {
    // The read said "absent", so the commit uses create(); a 409 means someone
    // else won the race and the body must re-run — this is the claim path that
    // the 2026-07-27 upload loss turned on.
    const ops = new FakeCosmos();
    const store = new CosmosStore(flaky(ops, new ConflictError('already exists')));
    let bodyRuns = 0;

    await store.runTransaction(async (tx) => {
      bodyRuns += 1;
      const ref = store.collection('upload_dedup').doc('md5');
      await tx.get(ref);
      tx.set(ref, { owner: 'me' }, { merge: true });
    });

    expect(bodyRuns).toBe(2);
  });

  it('refuses a transaction that writes two different documents', async () => {
    // Cosmos has no cross-partition atomicity; failing loudly beats pretending.
    const store = new CosmosStore(new FakeCosmos());
    await expect(
      store.runTransaction(async (tx) => {
        tx.set(store.collection('events').doc('a'), { x: 1 });
        tx.set(store.collection('events').doc('b'), { x: 2 });
      }),
    ).rejects.toThrow(/only single-document transactions/);
  });

  it('set+merge retries rather than losing a concurrent write', async () => {
    const ops = new FakeCosmos();
    const store = new CosmosStore(flaky(ops, new PreconditionFailedError('etag mismatch')));
    await ops.create('events', { id: 'e1', a: 1 });
    await store.collection('events').doc('e1').set({ b: 2 }, { merge: true });
    const row = ops.containers.get('events')?.get('e1');
    expect(row?.a).toBe(1);
    expect(row?.b).toBe(2);
  });
});
