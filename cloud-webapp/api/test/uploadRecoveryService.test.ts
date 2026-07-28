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

process.env.VOLUNTEER_STAGING_BUCKET = 'staging-bucket';

const getFiles = vi.fn();
vi.mock('../src/services/volunteerUploadService.js', () => ({
  getStorage: () => ({ bucket: () => ({ getFiles: (...a: unknown[]) => getFiles(...a) }) }),
}));

const enqueueProcessBatchTask = vi.fn();
const isUploadDispatchConfigured = vi.fn(() => true);
vi.mock('../src/services/uploadDispatch.js', () => ({
  enqueueProcessBatchTask: (...a: unknown[]) => enqueueProcessBatchTask(...a),
  isUploadDispatchConfigured: () => isUploadDispatchConfigured(),
}));

/** contentHash values the photo index holds for the event (i.e. already in Drive). */
let indexHashes: string[] = [];
vi.mock('../src/lib/firestore.js', () => ({
  firestore: () => ({
    collection: () => ({
      where: () => ({
        select: () => ({
          get: async () => ({
            docs: indexHashes.map((h) => ({ get: (f: string) => (f === 'contentHash' ? h : undefined) })),
          }),
        }),
      }),
    }),
  }),
}));

const { scanStagedRecovery, dispatchStagedRecovery } = await import('../src/services/uploadRecoveryService.js');

const EV = 'ev1';
const hex = (s: string): string => Buffer.from(s).toString('hex').padEnd(32, '0').slice(0, 32);
const b64 = (s: string): string => Buffer.from(hex(s), 'hex').toString('base64');

/** A staged object as the GCS client hands it back. */
function obj(batch: string, id: string, opts: { md5?: string; who?: string; link?: string; size?: number } = {}) {
  return {
    name: `volunteer_uploads/${EV}/${batch}/${id}.jpg`,
    metadata: {
      ...(opts.md5 === undefined ? {} : { md5Hash: b64(opts.md5) }),
      size: String(opts.size ?? 1000),
      metadata: {
        eventId: EV,
        linkId: opts.link ?? 'link-1',
        clubName: 'Misty_Mountain',
        tag: 'ALL',
        originalName: `${id}.JPG`,
        photographerName: opts.who ?? 'Liyi Guo',
        batchId: batch,
      },
    },
  };
}

beforeEach(() => {
  indexHashes = [];
  getFiles.mockReset().mockResolvedValue([[]]);
  enqueueProcessBatchTask.mockReset().mockResolvedValue(undefined);
  isUploadDispatchConfigured.mockReset().mockReturnValue(true);
});

describe('scanStagedRecovery', () => {
  it('counts only staged objects whose content is NOT already in Drive', async () => {
    getFiles.mockResolvedValue([[obj('b1', 'a', { md5: 'aa' }), obj('b1', 'b', { md5: 'bb' })]]);
    indexHashes = [hex('aa')]; // 'a' already copied; only 'b' is owed

    const scan = await scanStagedRecovery(EV);
    expect(scan.stagedObjects).toBe(2);
    expect(scan.strandedObjects).toBe(1);
    expect(scan.batches[0]).toMatchObject({ batchId: 'b1', stranded: 1, staged: 2 });
  });

  it('reports nothing to do once everything is in Drive', async () => {
    getFiles.mockResolvedValue([[obj('b1', 'a', { md5: 'aa' })]]);
    indexHashes = [hex('aa')];
    const scan = await scanStagedRecovery(EV);
    expect(scan.strandedObjects).toBe(0);
    expect(scan.batches).toEqual([]);
  });

  it('treats an object with no md5 as stranded — unknown is not "already done"', async () => {
    getFiles.mockResolvedValue([[obj('b1', 'a')]]);
    indexHashes = [hex('aa')];
    expect((await scanStagedRecovery(EV)).strandedObjects).toBe(1);
  });

  it('surfaces credit, including the uncredited blank-name case', async () => {
    getFiles.mockResolvedValue([
      [obj('b1', 'a', { md5: 'aa', who: 'Rebecca Tan' }), obj('b2', 'b', { md5: 'bb', who: '' })],
    ]);
    const scan = await scanStagedRecovery(EV);
    expect(scan.uncredited).toBe(1);
    const b1 = scan.batches.find((b) => b.batchId === 'b1')!;
    const b2 = scan.batches.find((b) => b.batchId === 'b2')!;
    expect(b1).toMatchObject({ photographerName: 'Rebecca Tan', fullyCredited: true });
    expect(b2.fullyCredited).toBe(false);
  });

  it('orders batches worst-first and totals the bytes owed', async () => {
    getFiles.mockResolvedValue([
      [obj('small', 'a', { md5: 'a1', size: 10 }), obj('big', 'b', { md5: 'b1', size: 100 }), obj('big', 'c', { md5: 'c1', size: 100 })],
    ]);
    const scan = await scanStagedRecovery(EV);
    expect(scan.batches.map((b) => b.batchId)).toEqual(['big', 'small']);
    expect(scan.strandedBytes).toBe(210);
  });
});

describe('dispatchStagedRecovery', () => {
  it('DRY RUN by default — plans the work but dispatches nothing', async () => {
    getFiles.mockResolvedValue([[obj('b1', 'a', { md5: 'aa' })]]);
    const out = await dispatchStagedRecovery(EV);
    expect(out.apply).toBe(false);
    expect(out.objects).toBe(1);
    expect(out.tasks).toBe(1);
    expect(enqueueProcessBatchTask).not.toHaveBeenCalled();
  });

  it('truthy-but-not-true must not dispatch', async () => {
    getFiles.mockResolvedValue([[obj('b1', 'a', { md5: 'aa' })]]);
    await dispatchStagedRecovery(EV, { apply: 'yes' as unknown as boolean });
    expect(enqueueProcessBatchTask).not.toHaveBeenCalled();
  });

  it('dispatches by linkId, since staged objects never carry the public token', async () => {
    getFiles.mockResolvedValue([[obj('b1', 'a', { md5: 'aa', link: 'link-7' })]]);
    await dispatchStagedRecovery(EV, { apply: true });
    const payload = enqueueProcessBatchTask.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.linkId).toBe('link-7');
    expect(payload.token).toBeUndefined();
    expect(payload.objectNames).toEqual([`volunteer_uploads/${EV}/b1/a.jpg`]);
  });

  it('never re-dispatches content that is already in Drive', async () => {
    getFiles.mockResolvedValue([[obj('b1', 'a', { md5: 'aa' }), obj('b1', 'b', { md5: 'bb' })]]);
    indexHashes = [hex('aa')];
    await dispatchStagedRecovery(EV, { apply: true });
    const payload = enqueueProcessBatchTask.mock.calls[0]![0] as { objectNames: string[] };
    expect(payload.objectNames).toEqual([`volunteer_uploads/${EV}/b1/b.jpg`]);
  });

  it('chunks a big batch and gives each chunk its own recovery batchId', async () => {
    // 5 objects, chunk 2 → 3 tasks. The suffix keeps the Cloud Tasks name unique
    // and leaves the volunteer's original status doc untouched.
    getFiles.mockResolvedValue([[...Array.from({ length: 5 }, (_, i) => obj('b1', `f${i}`, { md5: `m${i}` }))]]);
    const out = await dispatchStagedRecovery(EV, { apply: true, chunkSize: 2 });
    expect(out.tasks).toBe(3);
    expect(out.objects).toBe(5);
    const ids = enqueueProcessBatchTask.mock.calls.map((c) => (c[0] as { batchId: string }).batchId);
    expect(ids).toEqual(['b1-rec1', 'b1-rec2', 'b1-rec3']);
  });

  it('STAGGERS chunks so they cannot all land on one instance at once', async () => {
    // The live run dispatched 10 chunks simultaneously, Cloud Run packed them
    // onto one 512MiB instance and OOM-killed it. Each chunk must now be
    // scheduled after the previous one should have finished.
    getFiles.mockResolvedValue([[...Array.from({ length: 6 }, (_, i) => obj('b1', `f${i}`, { md5: `m${i}` }))]]);
    const before = Date.now();
    await dispatchStagedRecovery(EV, { apply: true, chunkSize: 2 });

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
    getFiles.mockResolvedValue([[...Array.from({ length: 100 }, (_, i) => obj('b1', `f${i}`, { md5: `m${i}` }))]]);
    const out = await dispatchStagedRecovery(EV, { apply: true });
    expect(out.objects).toBe(100);
    expect(out.estimatedMinutes).toBe(2); // 100 tiny files x 1.2s = 120s
  });

  it('estimates VIDEO batches from their bytes, not their file count', async () => {
    // The bug this fixes: 5 MP4s totalling 8.8 GB were estimated at "~1 minute"
    // (5 x 1.2s) and actually took 21.6. The byte term dominates for video.
    const GB = 1024 ** 3;
    getFiles.mockResolvedValue([
      [...Array.from({ length: 5 }, (_, i) => obj('vid', `v${i}`, { md5: `v${i}`, size: 1.76 * GB }))],
    ]);
    const out = await dispatchStagedRecovery(EV, { apply: true });
    expect(out.objects).toBe(5);
    // ~8.8 GB at 6 MB/s ~= 25 min, in the right ballpark of the real 21.6.
    expect(out.estimatedMinutes).toBeGreaterThan(15);
    expect(out.estimatedMinutes).toBeLessThan(35);
  });

  it('reports a duration on a DRY RUN too, so the operator can plan', async () => {
    const GB = 1024 ** 3;
    getFiles.mockResolvedValue([[obj('vid', 'v0', { md5: 'v0', size: 4 * GB })]]);
    const out = await dispatchStagedRecovery(EV);
    expect(out.apply).toBe(false);
    expect(out.estimatedMinutes).toBeGreaterThan(5);
  });

  it('caps a chunk by BYTES so one task cannot outlive the request timeout', async () => {
    // 4 x 4 GiB with chunkSize 400: the count cap would make ONE 16 GiB task,
    // which no 1800s request could finish. The byte cap splits it instead.
    const GB = 1024 ** 3;
    getFiles.mockResolvedValue([
      [...Array.from({ length: 4 }, (_, i) => obj('vid', `v${i}`, { md5: `v${i}`, size: 4 * GB }))],
    ]);
    const out = await dispatchStagedRecovery(EV, { apply: true, chunkSize: 400 });
    expect(out.objects).toBe(4);
    expect(out.tasks).toBeGreaterThan(1);
    // Every dispatched chunk stays under the 6 GiB ceiling -> at most 1 per task here.
    for (const c of enqueueProcessBatchTask.mock.calls) {
      expect((c[0] as { objectNames: string[] }).objectNames.length).toBeLessThanOrEqual(2);
    }
  });

  it('never drops an object larger than the byte cap', async () => {
    const GB = 1024 ** 3;
    getFiles.mockResolvedValue([[obj('vid', 'huge', { md5: 'h', size: 9 * GB })]]);
    const out = await dispatchStagedRecovery(EV, { apply: true });
    expect(out.objects).toBe(1);
    expect(out.tasks).toBe(1);
  });

  it('can target specific batches', async () => {
    getFiles.mockResolvedValue([[obj('b1', 'a', { md5: 'aa' }), obj('b2', 'b', { md5: 'bb' })]]);
    const out = await dispatchStagedRecovery(EV, { apply: true, batchIds: ['b2'] });
    expect(out.batches).toBe(1);
    const payload = enqueueProcessBatchTask.mock.calls[0]![0] as { objectNames: string[] };
    expect(payload.objectNames).toEqual([`volunteer_uploads/${EV}/b2/b.jpg`]);
  });

  it('skips a batch with no linkId rather than guessing the club', async () => {
    getFiles.mockResolvedValue([[obj('b1', 'a', { md5: 'aa', link: '' })]]);
    const out = await dispatchStagedRecovery(EV, { apply: true });
    expect(enqueueProcessBatchTask).not.toHaveBeenCalled();
    expect(out.notDispatched).toBe(1);
    expect(out.warnings.join(' ')).toContain('no linkId');
  });

  it('refuses to apply when Cloud Tasks dispatch is not configured', async () => {
    getFiles.mockResolvedValue([[obj('b1', 'a', { md5: 'aa' })]]);
    isUploadDispatchConfigured.mockReturnValue(false);
    const out = await dispatchStagedRecovery(EV, { apply: true });
    expect(out.objects).toBe(0);
    expect(enqueueProcessBatchTask).not.toHaveBeenCalled();
    expect(out.warnings.join(' ')).toContain('not configured');
  });

  it('counts a failed dispatch as not-dispatched instead of claiming success', async () => {
    getFiles.mockResolvedValue([[obj('b1', 'a', { md5: 'aa' })]]);
    enqueueProcessBatchTask.mockRejectedValue(new Error('queue down'));
    const out = await dispatchStagedRecovery(EV, { apply: true });
    expect(out.objects).toBe(0);
    expect(out.tasks).toBe(0);
    expect(out.notDispatched).toBe(1);
    expect(out.warnings.join(' ')).toContain('queue down');
  });
});
