/**
 * uploadSweepService — filing volunteer sessions that never reached /complete.
 *
 * WHAT THIS PROTECTS: on NYC Marathon night (2026-11-01/02) five sessions, 1,550
 * photos, staged their bytes and never called /complete, so nothing copied them
 * to Drive until an admin noticed. The sweep must file exactly those — and must
 * NOT race a live session whose /complete is still coming, re-dispatch a batch
 * the pipeline or an admin already owns, or do anything on an idle tick.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { fakeStore } from './helpers/fakeDb.js';
import { FakeObjectStore } from './helpers/fakeObjectStore.js';

process.env.VOLUNTEER_STAGING_BUCKET = 'staging-bucket';

const storage = new FakeObjectStore();
vi.mock('../src/lib/storage.js', () => ({ objectStore: () => storage }));

let db = fakeStore();
vi.mock('../src/lib/firestore.js', () => ({ firestore: () => db }));

const enqueueProcessBatchTask = vi.fn();
const isUploadDispatchConfigured = vi.fn(() => true);
vi.mock('../src/services/uploadDispatch.js', () => ({
  enqueueProcessBatchTask: (...a: unknown[]) => enqueueProcessBatchTask(...a),
  isUploadDispatchConfigured: () => isUploadDispatchConfigured(),
}));

const { sweepNeverCompletedUploads, DEFAULT_MIN_AGE_MS } = await import('../src/services/uploadSweepService.js');

const NOW = Date.parse('2026-11-02T12:00:00Z');
const HOUR = 60 * 60 * 1000;
const hex = (s: string): string => Buffer.from(s).toString('hex').padEnd(32, '0').slice(0, 32);

/** Stage one object `ageMs` before NOW. `ageMs: null` = provider reports no commit time. */
function stage(
  ev: string,
  batch: string,
  id: string,
  opts: { ageMs?: number | null; md5?: string; link?: string; size?: number } = {},
): void {
  const age = opts.ageMs === undefined ? 3 * HOUR : opts.ageMs;
  storage.seed('staging-bucket', `volunteer_uploads/${ev}/${batch}/${id}.jpg`, {
    md5Hex: hex(opts.md5 ?? `${ev}${batch}${id}`),
    size: opts.size ?? 1000,
    createdMs: age === null ? 0 : NOW - age,
    custom: { eventId: ev, linkId: opts.link ?? 'link-1', photographerName: 'Liyi Guo', batchId: batch },
  });
}

function dispatchedObjects(): string[] {
  return enqueueProcessBatchTask.mock.calls.flatMap((c) => (c[0] as { objectNames: string[] }).objectNames).sort();
}

const sweep = (opts: Parameters<typeof sweepNeverCompletedUploads>[0] = {}) =>
  sweepNeverCompletedUploads({ now: NOW, ...opts });

beforeEach(() => {
  db = fakeStore();
  storage.reset();
  enqueueProcessBatchTask.mockReset().mockResolvedValue(undefined);
  isUploadDispatchConfigured.mockReset().mockReturnValue(true);
});

describe('sweepNeverCompletedUploads', () => {
  it('is a no-op on an empty staging bucket — one listing, nothing else', async () => {
    const out = await sweep({ apply: true });
    expect(out).toMatchObject({ stagedObjects: 0, candidates: [], objects: 0 });
    expect(enqueueProcessBatchTask).not.toHaveBeenCalled();
    expect(db.ids('upload_batches')).toEqual([]);
  });

  it('files an abandoned session through the normal recovery dispatch', async () => {
    stage('ev1', 'b1', 'a');
    stage('ev1', 'b1', 'b');
    const out = await sweep({ apply: true });

    expect(out.candidates).toHaveLength(1);
    expect(out.candidates[0]).toMatchObject({ eventId: 'ev1', batchId: 'b1', objects: 2 });
    expect(out.objects).toBe(2);
    const payload = enqueueProcessBatchTask.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.linkId).toBe('link-1');
    expect(payload.batchId).toBe('b1-rec1');
    // ...and marks it, so the next tick leaves it alone.
    expect(db.peek('upload_batches', 'b1')).toMatchObject({ phase: 'received', recoveryObjects: 2 });
  });

  it('is idempotent: a second tick dispatches nothing', async () => {
    stage('ev1', 'b1', 'a');
    await sweep({ apply: true });
    enqueueProcessBatchTask.mockClear();

    const again = await sweep({ apply: true });
    expect(again.owned).toBe(1);
    expect(again.candidates).toEqual([]);
    expect(enqueueProcessBatchTask).not.toHaveBeenCalled();
  });

  it('DRY RUN by default — reports the candidate, dispatches and marks nothing', async () => {
    stage('ev1', 'b1', 'a');
    const out = await sweep();
    expect(out.apply).toBe(false);
    expect(out.candidates).toHaveLength(1);
    expect(out.objects).toBe(1);
    expect(enqueueProcessBatchTask).not.toHaveBeenCalled();
    expect(db.ids('upload_batches')).toEqual([]);
  });

  it('truthy-but-not-true must not apply', async () => {
    stage('ev1', 'b1', 'a');
    await sweep({ apply: 'yes' as unknown as boolean });
    expect(enqueueProcessBatchTask).not.toHaveBeenCalled();
  });

  it('never races a live session: judged by its NEWEST file, not its oldest', async () => {
    // A long session's first file is hours old while it is still uploading.
    stage('ev1', 'live', 'early', { ageMs: 5 * HOUR });
    stage('ev1', 'live', 'just-now', { ageMs: 10 * 60 * 1000 });
    const out = await sweep({ apply: true });
    expect(out.tooRecent).toBe(1);
    expect(out.candidates).toEqual([]);
    expect(enqueueProcessBatchTask).not.toHaveBeenCalled();
  });

  it('files a session once its newest file passes the safe age', async () => {
    stage('ev1', 'b1', 'a', { ageMs: DEFAULT_MIN_AGE_MS + 1 });
    expect((await sweep({ apply: true })).objects).toBe(1);
  });

  it('treats an unknown commit time as too recent, never as old', async () => {
    stage('ev1', 'b1', 'a', { ageMs: 9 * HOUR });
    stage('ev1', 'b1', 'b', { ageMs: null });
    const out = await sweep({ apply: true });
    expect(out.tooRecent).toBe(1);
    expect(enqueueProcessBatchTask).not.toHaveBeenCalled();
  });

  it('will not let a caller shrink the safe age below the 1h floor', async () => {
    stage('ev1', 'b1', 'a', { ageMs: 30 * 60 * 1000 });
    const out = await sweep({ apply: true, minAgeMs: 60_000 });
    expect(out.minAgeMinutes).toBe(60);
    expect(enqueueProcessBatchTask).not.toHaveBeenCalled();
  });

  it('leaves a batch that reached /complete to the normal pipeline', async () => {
    // Its doc exists, so the Cloud Tasks worker (and its retries) own it. This
    // is also what protects the orphans the worker deliberately KEEPS on an
    // unproven duplicate — their batch has a doc.
    db.seed('upload_batches', { b1: { batchId: 'b1', phase: 'saving' } });
    stage('ev1', 'b1', 'a');
    const out = await sweep({ apply: true });
    expect(out.owned).toBe(1);
    expect(enqueueProcessBatchTask).not.toHaveBeenCalled();
  });

  it('leaves a batch an admin already recovered (its -rec1 worker doc exists)', async () => {
    // Recoveries dispatched before markers existed — the 2026-11-02 hand-run
    // ones — have only `<batchId>-rec1`.
    db.seed('upload_batches', { 'b1-rec1': { batchId: 'b1-rec1', phase: 'done' } });
    stage('ev1', 'b1', 'a');
    expect((await sweep({ apply: true })).owned).toBe(1);
    expect(enqueueProcessBatchTask).not.toHaveBeenCalled();
  });

  it('skips content already in the photo index, and marks a batch with nothing owed', async () => {
    db.seed('photos', { p1: { eventId: 'ev1', contentHash: hex('dup') } });
    stage('ev1', 'b1', 'a', { md5: 'dup' });
    stage('ev1', 'b2', 'b', { md5: 'dup' });
    stage('ev1', 'b2', 'c');
    const out = await sweep({ apply: true });

    expect(dispatchedObjects()).toEqual(['volunteer_uploads/ev1/b2/c.jpg']);
    expect(out.nothingOwed).toBe(1);
    // b1 is marked so the next tick does not re-read the event's photo index.
    expect(db.peek('upload_batches', 'b1')).toMatchObject({ recoveryObjects: 0 });
    // And nothing was deleted from staging — only the worker ever deletes.
    expect(storage.removed).toEqual([]);
  });

  it('chains the stagger ACROSS events so their chunks do not land together', async () => {
    stage('ev1', 'b1', 'a');
    stage('ev2', 'b2', 'b');
    await sweep({ apply: true });
    const times = enqueueProcessBatchTask.mock.calls.map((c) =>
      Date.parse((c[1] as { scheduleTime: string }).scheduleTime),
    );
    expect(times).toHaveLength(2);
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(1000);
  });

  it('caps one tick at ~50 min of staggered work and leaves the rest UNMARKED for the next', async () => {
    // Each 3 GiB file is ~8.5 min at 6 MB/s; ten batches is far past one tick.
    const GB = 1024 ** 3;
    for (let i = 0; i < 10; i++) stage('ev1', `b${i}`, 'v', { size: 3 * GB });
    const out = await sweep({ apply: true });

    expect(out.objects).toBeGreaterThan(0);
    expect(out.objects).toBeLessThan(10);
    expect(out.notDispatched).toBe(10 - out.objects);
    const marked = db.ids('upload_batches');
    expect(marked).toHaveLength(out.objects);

    // The next tick picks up exactly the rest.
    enqueueProcessBatchTask.mockClear();
    const next = await sweep({ apply: true });
    expect(next.owned).toBe(out.objects);
    expect(next.objects).toBeGreaterThan(0);
  });

  it('records a batch with no linkId once instead of re-examining it every tick', async () => {
    stage('ev1', 'b1', 'a', { link: '' });
    const out = await sweep({ apply: true });
    expect(enqueueProcessBatchTask).not.toHaveBeenCalled();
    expect(out.warnings.join(' ')).toContain('no linkId');
    expect(db.peek('upload_batches', 'b1')).toMatchObject({ recoverySkipped: 'no_link' });
  });

  it('does not mark a batch whose dispatch failed — the next tick retries it', async () => {
    stage('ev1', 'b1', 'a');
    enqueueProcessBatchTask.mockRejectedValue(new Error('queue down'));
    const out = await sweep({ apply: true });
    expect(out.objects).toBe(0);
    expect(out.notDispatched).toBe(1);
    expect(db.peek('upload_batches', 'b1')).toBeUndefined();
  });

  it('refuses to apply, and writes no markers, when dispatch is not configured', async () => {
    stage('ev1', 'b1', 'a');
    isUploadDispatchConfigured.mockReturnValue(false);
    const out = await sweep({ apply: true });
    expect(out.warnings.join(' ')).toContain('not configured');
    expect(db.ids('upload_batches')).toEqual([]);
  });

  it('propagates a failed record read rather than treating it as "never completed"', async () => {
    stage('ev1', 'b1', 'a');
    const real = db.collection.bind(db);
    db.collection = ((name: string) => {
      if (name === 'upload_batches') throw new Error('firestore unavailable');
      return real(name);
    }) as typeof db.collection;
    await expect(sweep({ apply: true })).rejects.toThrow('firestore unavailable');
    expect(enqueueProcessBatchTask).not.toHaveBeenCalled();
  });
});
