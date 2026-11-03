/**
 * uploadRecoveryService — re-driving volunteer photos stranded in staging.
 *
 * WHAT THIS PROTECTS: 1,188 photos (~5.1 GB) sat in the staging bucket on
 * 2026-07-27, never copied to Drive because the worker was killed at the 60s
 * timeout and Cloud Tasks gave up after 5 attempts. The recovery must put those
 * back WITHOUT re-copying the ~1,300 staged objects whose content is already in
 * Drive — re-copying them would recreate exactly the duplicate mess the
 * duplicate-removal tool exists to clean up.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { fakeStore } from './helpers/fakeDb.js';
import { FakeObjectStore, type SeedOptions } from './helpers/fakeObjectStore.js';

process.env.VOLUNTEER_STAGING_BUCKET = 'staging-bucket';

// The shared in-memory ObjectStore (AZ2), not a bespoke GCS-shaped literal: the
// recovery path reads md5/size/custom straight off a listing, and those are
// exactly the fields the two providers report differently.
const storage = new FakeObjectStore();
vi.mock('../src/lib/storage.js', () => ({ objectStore: () => storage }));

const enqueueProcessBatchTask = vi.fn();
const isUploadDispatchConfigured = vi.fn(() => true);
vi.mock('../src/services/uploadDispatch.js', () => ({
  enqueueProcessBatchTask: (...a: unknown[]) => enqueueProcessBatchTask(...a),
  isUploadDispatchConfigured: () => isUploadDispatchConfigured(),
}));

// The shared in-memory document store: recovery reads the photo index AND
// writes a marker onto `upload_batches`, so a query-shaped stub is not enough.
let db = fakeStore();
vi.mock('../src/lib/firestore.js', () => ({ firestore: () => db }));

/** contentHash values the photo index holds for the event (i.e. already in Drive). */
let indexHashes: string[] = [];
function seedIndex(): void {
  db.seed('photos', Object.fromEntries(indexHashes.map((h, i) => [`p${i}`, { eventId: EV, contentHash: h }])));
}

const { scanStagedRecovery, dispatchStagedRecovery } = await import('../src/services/uploadRecoveryService.js');

const EV = 'ev1';
const hex = (s: string): string => Buffer.from(s).toString('hex').padEnd(32, '0').slice(0, 32);

/** One staged object, as the store reports it. `md5` omitted = NO hash, which
 *  is what an unhashed object (and every Azure block-blob commit) looks like. */
function obj(
  batch: string,
  id: string,
  opts: { md5?: string; who?: string; link?: string; size?: number } = {},
): [key: string, seed: SeedOptions] {
  return [
    `volunteer_uploads/${EV}/${batch}/${id}.jpg`,
    {
      md5Hex: opts.md5 === undefined ? '' : hex(opts.md5),
      size: opts.size ?? 1000,
      custom: {
        eventId: EV,
        linkId: opts.link ?? 'link-1',
        clubName: 'Misty_Mountain',
        tag: 'ALL',
        originalName: `${id}.JPG`,
        photographerName: opts.who ?? 'Liyi Guo',
        batchId: batch,
      },
    },
  ];
}

/** Replace the staging bucket's contents with these objects. */
function stage(objs: Array<[key: string, seed: SeedOptions]>): void {
  storage.reset();
  for (const [key, seed] of objs) storage.seed('staging-bucket', key, seed);
}

/** Install `indexHashes` into the fake photo index, then scan. */
async function scanEvent(): Promise<Awaited<ReturnType<typeof scanStagedRecovery>>> {
  seedIndex();
  return scanStagedRecovery(EV);
}

/** Install `indexHashes`, then dispatch. */
async function dispatch(
  opts?: Parameters<typeof dispatchStagedRecovery>[1],
): Promise<Awaited<ReturnType<typeof dispatchStagedRecovery>>> {
  seedIndex();
  return dispatchStagedRecovery(EV, opts);
}

beforeEach(() => {
  indexHashes = [];
  db = fakeStore();
  storage.reset();
  enqueueProcessBatchTask.mockReset().mockResolvedValue(undefined);
  isUploadDispatchConfigured.mockReset().mockReturnValue(true);
});

describe('scanStagedRecovery', () => {
  it('counts only staged objects whose content is NOT already in Drive', async () => {
    stage([obj('b1', 'a', { md5: 'aa' }), obj('b1', 'b', { md5: 'bb' })]);
    indexHashes = [hex('aa')]; // 'a' already copied; only 'b' is owed

    const scan = await scanEvent();
    expect(scan.stagedObjects).toBe(2);
    expect(scan.strandedObjects).toBe(1);
    expect(scan.batches[0]).toMatchObject({ batchId: 'b1', stranded: 1, staged: 2 });
  });

  it('reports nothing to do once everything is in Drive', async () => {
    stage([obj('b1', 'a', { md5: 'aa' })]);
    indexHashes = [hex('aa')];
    const scan = await scanEvent();
    expect(scan.strandedObjects).toBe(0);
    expect(scan.batches).toEqual([]);
  });

  it('treats an object with no md5 as stranded — unknown is not "already done"', async () => {
    stage([obj('b1', 'a')]);
    indexHashes = [hex('aa')];
    expect((await scanEvent()).strandedObjects).toBe(1);
  });

  it('never counts an EMPTY object as owed — the worker can only skip it', async () => {
    // A session that never sent a byte. Counting it meant "would copy 3" on
    // every run, forever (NYC Marathon event, 2026-11-03).
    stage([obj('b1', 'empty', { size: 0 }), obj('b2', 'real', { md5: 'rr' })]);
    const scan = await scanEvent();
    expect(scan.stagedObjects).toBe(2);
    expect(scan.strandedObjects).toBe(1);
    expect(scan.batches.map((b) => b.batchId)).toEqual(['b2']);
  });

  it('does not dispatch an empty object', async () => {
    stage([obj('b1', 'empty', { size: 0 })]);
    const out = await dispatch({ apply: true });
    expect(out.objects).toBe(0);
    expect(enqueueProcessBatchTask).not.toHaveBeenCalled();
  });

  it('surfaces credit, including the uncredited blank-name case', async () => {
    stage([obj('b1', 'a', { md5: 'aa', who: 'Rebecca Tan' }), obj('b2', 'b', { md5: 'bb', who: '' })]);
    const scan = await scanEvent();
    expect(scan.uncredited).toBe(1);
    const b1 = scan.batches.find((b) => b.batchId === 'b1')!;
    const b2 = scan.batches.find((b) => b.batchId === 'b2')!;
    expect(b1).toMatchObject({ photographerName: 'Rebecca Tan', fullyCredited: true });
    expect(b2.fullyCredited).toBe(false);
  });

  it('orders batches worst-first and totals the bytes owed', async () => {
    stage([obj('small', 'a', { md5: 'a1', size: 10 }), obj('big', 'b', { md5: 'b1', size: 100 }), obj('big', 'c', { md5: 'c1', size: 100 })]);
    const scan = await scanEvent();
    expect(scan.batches.map((b) => b.batchId)).toEqual(['big', 'small']);
    expect(scan.strandedBytes).toBe(210);
  });
});

describe('dispatchStagedRecovery', () => {
  it('DRY RUN by default — plans the work but dispatches nothing', async () => {
    stage([obj('b1', 'a', { md5: 'aa' })]);
    const out = await dispatch();
    expect(out.apply).toBe(false);
    expect(out.objects).toBe(1);
    expect(out.tasks).toBe(1);
    expect(enqueueProcessBatchTask).not.toHaveBeenCalled();
  });

  it('truthy-but-not-true must not dispatch', async () => {
    stage([obj('b1', 'a', { md5: 'aa' })]);
    await dispatch({ apply: 'yes' as unknown as boolean });
    expect(enqueueProcessBatchTask).not.toHaveBeenCalled();
  });

  it('dispatches by linkId, since staged objects never carry the public token', async () => {
    stage([obj('b1', 'a', { md5: 'aa', link: 'link-7' })]);
    await dispatch({ apply: true });
    const payload = enqueueProcessBatchTask.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.linkId).toBe('link-7');
    expect(payload.token).toBeUndefined();
    expect(payload.objectNames).toEqual([`volunteer_uploads/${EV}/b1/a.jpg`]);
  });

  it('never re-dispatches content that is already in Drive', async () => {
    stage([obj('b1', 'a', { md5: 'aa' }), obj('b1', 'b', { md5: 'bb' })]);
    indexHashes = [hex('aa')];
    await dispatch({ apply: true });
    const payload = enqueueProcessBatchTask.mock.calls[0]![0] as { objectNames: string[] };
    expect(payload.objectNames).toEqual([`volunteer_uploads/${EV}/b1/b.jpg`]);
  });

  it('chunks a big batch and gives each chunk its own recovery batchId', async () => {
    // 5 objects, chunk 2 → 3 tasks. The suffix keeps the Cloud Tasks name unique
    // and leaves the volunteer's original status doc untouched.
    stage([...Array.from({ length: 5 }, (_, i) => obj('b1', `f${i}`, { md5: `m${i}` }))]);
    const out = await dispatch({ apply: true, chunkSize: 2 });
    expect(out.tasks).toBe(3);
    expect(out.objects).toBe(5);
    const ids = enqueueProcessBatchTask.mock.calls.map((c) => (c[0] as { batchId: string }).batchId);
    expect(ids).toEqual(['b1-rec1', 'b1-rec2', 'b1-rec3']);
  });

  it('STAGGERS chunks so they cannot all land on one instance at once', async () => {
    // The live run dispatched 10 chunks simultaneously, Cloud Run packed them
    // onto one 512MiB instance and OOM-killed it. Each chunk must now be
    // scheduled after the previous one should have finished.
    stage([...Array.from({ length: 6 }, (_, i) => obj('b1', `f${i}`, { md5: `m${i}` }))]);
    const before = Date.now();
    await dispatch({ apply: true, chunkSize: 2 });

    const times = enqueueProcessBatchTask.mock.calls.map((c) =>
      Date.parse((c[1] as { scheduleTime: string }).scheduleTime),
    );
    expect(times).toHaveLength(3);
    // First goes out immediately; each later one is pushed further out.
    expect(times[0]!).toBeLessThanOrEqual(before + 1000);
    expect(times[1]!).toBeGreaterThan(times[0]!);
    expect(times[2]!).toBeGreaterThan(times[1]!);
    // Spacing reflects the size of the preceding chunk (2 objects).
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(2000);
  });

  it('reports how long the run will take, from objects AND bytes', async () => {
    stage([...Array.from({ length: 100 }, (_, i) => obj('b1', `f${i}`, { md5: `m${i}` }))]);
    const out = await dispatch({ apply: true });
    expect(out.objects).toBe(100);
    expect(out.estimatedMinutes).toBe(2); // 100 tiny files x 1.2s = 120s
  });

  it('estimates VIDEO batches from their bytes, not their file count', async () => {
    // The bug this fixes: 5 MP4s totalling 8.8 GB were estimated at "~1 minute"
    // (5 x 1.2s) and actually took 21.6. The byte term dominates for video.
    const GB = 1024 ** 3;
    stage([...Array.from({ length: 5 }, (_, i) => obj('vid', `v${i}`, { md5: `v${i}`, size: 1.76 * GB }))]);
    const out = await dispatch({ apply: true });
    expect(out.objects).toBe(5);
    // ~8.8 GB at 6 MB/s ~= 25 min, in the right ballpark of the real 21.6.
    expect(out.estimatedMinutes).toBeGreaterThan(15);
    expect(out.estimatedMinutes).toBeLessThan(35);
  });

  it('reports a duration on a DRY RUN too, so the operator can plan', async () => {
    const GB = 1024 ** 3;
    stage([obj('vid', 'v0', { md5: 'v0', size: 4 * GB })]);
    const out = await dispatch();
    expect(out.apply).toBe(false);
    expect(out.estimatedMinutes).toBeGreaterThan(5);
  });

  it('caps a chunk by BYTES so one task cannot outlive the request timeout', async () => {
    // 4 x 4 GiB with chunkSize 400: the count cap would make ONE 16 GiB task,
    // which no 1800s request could finish. The byte cap splits it instead.
    const GB = 1024 ** 3;
    stage([...Array.from({ length: 4 }, (_, i) => obj('vid', `v${i}`, { md5: `v${i}`, size: 4 * GB }))]);
    const out = await dispatch({ apply: true, chunkSize: 400 });
    expect(out.objects).toBe(4);
    expect(out.tasks).toBeGreaterThan(1);
    // Every dispatched chunk stays under the 6 GiB ceiling -> at most 1 per task here.
    for (const c of enqueueProcessBatchTask.mock.calls) {
      expect((c[0] as { objectNames: string[] }).objectNames.length).toBeLessThanOrEqual(2);
    }
  });

  it('never drops an object larger than the byte cap', async () => {
    const GB = 1024 ** 3;
    stage([obj('vid', 'huge', { md5: 'h', size: 9 * GB })]);
    const out = await dispatch({ apply: true });
    expect(out.objects).toBe(1);
    expect(out.tasks).toBe(1);
  });

  it('can target specific batches', async () => {
    stage([obj('b1', 'a', { md5: 'aa' }), obj('b2', 'b', { md5: 'bb' })]);
    const out = await dispatch({ apply: true, batchIds: ['b2'] });
    expect(out.batches).toBe(1);
    const payload = enqueueProcessBatchTask.mock.calls[0]![0] as { objectNames: string[] };
    expect(payload.objectNames).toEqual([`volunteer_uploads/${EV}/b2/b.jpg`]);
  });

  it('skips a batch with no linkId rather than guessing the club', async () => {
    stage([obj('b1', 'a', { md5: 'aa', link: '' })]);
    const out = await dispatch({ apply: true });
    expect(enqueueProcessBatchTask).not.toHaveBeenCalled();
    expect(out.notDispatched).toBe(1);
    expect(out.warnings.join(' ')).toContain('no linkId');
  });

  it('refuses to apply when Cloud Tasks dispatch is not configured', async () => {
    stage([obj('b1', 'a', { md5: 'aa' })]);
    isUploadDispatchConfigured.mockReturnValue(false);
    const out = await dispatch({ apply: true });
    expect(out.objects).toBe(0);
    expect(enqueueProcessBatchTask).not.toHaveBeenCalled();
    expect(out.warnings.join(' ')).toContain('not configured');
  });

  it('marks a fully dispatched batch so the scheduled sweep does not redo it', async () => {
    // No doc existed (the session never reached /complete): the marker CREATES
    // one, in phase `received`, recording what recovery queued.
    stage([obj('b1', 'a', { md5: 'aa' }), obj('b1', 'b', { md5: 'bb' })]);
    const out = await dispatch({ apply: true });
    expect(out.dispatchedBatchIds).toEqual(['b1']);
    expect(db.peek('upload_batches', 'b1')).toMatchObject({
      batchId: 'b1',
      eventId: EV,
      linkId: 'link-1',
      phase: 'received',
      recoveryObjects: 2,
    });
  });

  it('only ADDS recovery fields to a volunteer\'s existing status doc', async () => {
    db.seed('upload_batches', { b1: { batchId: 'b1', phase: 'saving', copied: 7, batchFolderName: 'F' } });
    stage([obj('b1', 'a', { md5: 'aa' })]);
    await dispatch({ apply: true });
    const doc = db.peek('upload_batches', 'b1')!;
    expect(doc).toMatchObject({ phase: 'saving', copied: 7, batchFolderName: 'F', recoveryObjects: 1 });
    expect(typeof doc.recoveryDispatchedAt).toBe('string');
  });

  it('writes no marker on a dry run', async () => {
    stage([obj('b1', 'a', { md5: 'aa' })]);
    await dispatch();
    expect(db.peek('upload_batches', 'b1')).toBeUndefined();
  });

  it('does not mark a batch whose dispatch failed, so a later run retries it', async () => {
    stage([obj('b1', 'a', { md5: 'aa' })]);
    enqueueProcessBatchTask.mockRejectedValue(new Error('queue down'));
    const out = await dispatch({ apply: true });
    expect(out.dispatchedBatchIds).toEqual([]);
    expect(db.peek('upload_batches', 'b1')).toBeUndefined();
  });

  it('chains its stagger after `startAtMs`, and reports where the schedule ended', async () => {
    stage([obj('b1', 'a', { md5: 'aa' })]);
    const before = Date.now();
    const out = await dispatch({ apply: true, startAtMs: 600_000 });
    const at = Date.parse((enqueueProcessBatchTask.mock.calls[0]![1] as { scheduleTime: string }).scheduleTime);
    expect(at).toBeGreaterThanOrEqual(before + 600_000);
    expect(out.plannedMs).toBeGreaterThan(600_000);
    expect(out.estimatedMinutes).toBe(1); // the run's own length, not the offset
  });

  it('defers WHOLE batches past `maxPlannedMs`, never half of one', async () => {
    // Two 3-object batches, chunk 1: each object is ~1.2s of schedule, so a 2s
    // budget lets the first batch start and holds the second back entirely.
    stage([
      ...['a', 'b', 'c'].map((id) => obj('b1', id, { md5: `1${id}` })),
      ...['d', 'e', 'f'].map((id) => obj('b2', id, { md5: `2${id}` })),
    ]);
    const out = await dispatch({ apply: true, chunkSize: 1, maxPlannedMs: 2000 });
    expect(out.dispatchedBatchIds).toEqual(['b1']);
    expect(out.objects).toBe(3);
    expect(out.deferredBatches).toBe(1);
    expect(out.notDispatched).toBe(3);
    expect(db.peek('upload_batches', 'b2')).toBeUndefined();
  });

  it('counts a failed dispatch as not-dispatched instead of claiming success', async () => {
    stage([obj('b1', 'a', { md5: 'aa' })]);
    enqueueProcessBatchTask.mockRejectedValue(new Error('queue down'));
    const out = await dispatch({ apply: true });
    expect(out.objects).toBe(0);
    expect(out.tasks).toBe(0);
    expect(out.notDispatched).toBe(1);
    expect(out.warnings.join(' ')).toContain('queue down');
  });
});
