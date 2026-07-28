/**
 * uploadDedupService — the claim that stops two batches copying the same photo,
 * and the stale-claim reclaim that stops a dead worker blocking it forever.
 *
 * THE INCIDENT THESE GUARD (2026-07-27): the api was deployed with a 60s request
 * timeout, so the upload worker was KILLED mid-batch. A kill runs no catch block,
 * so `releaseUploadedFile` never ran and the claim — written BEFORE the copy,
 * stamped with `driveFileId` only AFTER — was stranded with no Drive file behind
 * it. Every later re-upload of those exact bytes was then silently skipped as a
 * duplicate, which is why the loss never self-healed. A claim older than any
 * possible request lifetime must therefore be reclaimable.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

interface Doc {
  driveFileId?: string;
  claimedAt?: unknown;
  batchId?: string;
  name?: string;
  reclaimedFrom?: string;
}

const docs = new Map<string, Doc>();
/** Set to make runTransaction blow up, modelling a Firestore outage. */
let txFails = false;
/** Set to make create() fail with something other than ALREADY_EXISTS. */
let createError: Error | null = null;

vi.mock('../src/lib/firestore.js', () => ({
  firestore: () => ({
    collection: () => ({
      doc: (id: string) => ({
        __id: id,
        create: async (data: Doc) => {
          if (createError) throw createError;
          if (docs.has(id)) {
            throw Object.assign(new Error('6 ALREADY_EXISTS: entity already exists'), { code: 6 });
          }
          docs.set(id, data);
        },
        set: async (data: Doc) => void docs.set(id, { ...docs.get(id), ...data }),
        delete: async () => void docs.delete(id),
      }),
    }),
    runTransaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      if (txFails) throw new Error('firestore unavailable');
      const tx = {
        get: async (ref: { __id: string }) => ({
          exists: docs.has(ref.__id),
          data: () => docs.get(ref.__id),
        }),
        update: (ref: { __id: string }, patch: Doc) =>
          void docs.set(ref.__id, { ...docs.get(ref.__id), ...patch }),
      };
      return fn(tx);
    },
  }),
}));

const { claimUploadedFile, claimId, UPLOAD_DEDUP_COLLECTION } = await import(
  '../src/services/uploadDedupService.js'
);

const INPUT = { eventId: 'ev1', dedupKey: 'abc123', name: 'race-001.jpg', batchId: 'batch-new' };
const ID = claimId(INPUT.eventId, INPUT.dedupKey);
const minutesAgo = (n: number): Date => new Date(Date.now() - n * 60 * 1000);

beforeEach(() => {
  docs.clear();
  txFails = false;
  createError = null;
});

describe('claimUploadedFile', () => {
  it('wins an unclaimed key', async () => {
    expect(await claimUploadedFile(INPUT)).toBe(true);
    expect(docs.get(ID)?.batchId).toBe('batch-new');
  });

  it('uses a stable, legal Firestore id scoped to the event', () => {
    expect(claimId('ev1', 'abc123')).toBe(claimId('ev1', 'abc123'));
    expect(claimId('ev1', 'abc123')).not.toBe(claimId('ev2', 'abc123'));
    expect(claimId('ev1', 'abc123')).toMatch(/^[0-9a-f]{40}$/);
    expect(UPLOAD_DEDUP_COLLECTION).toBe('upload_dedup');
  });

  it('refuses a key already backed by a real Drive file', async () => {
    docs.set(ID, { driveFileId: 'drive-1', claimedAt: minutesAgo(600), batchId: 'batch-old' });
    expect(await claimUploadedFile(INPUT)).toBe(false);
    // The winner's record is untouched.
    expect(docs.get(ID)?.batchId).toBe('batch-old');
  });

  it('refuses a fresh unstamped claim — another worker is copying it right now', async () => {
    docs.set(ID, { claimedAt: minutesAgo(2), batchId: 'batch-inflight' });
    expect(await claimUploadedFile(INPUT)).toBe(false);
    expect(docs.get(ID)?.batchId).toBe('batch-inflight');
  });

  it('RECLAIMS an unstamped claim older than any possible request', async () => {
    // Exactly the wreckage a 60s kill left behind: claimed, never stamped.
    docs.set(ID, { claimedAt: minutesAgo(120), batchId: 'batch-killed' });
    expect(await claimUploadedFile(INPUT)).toBe(true);
    const after = docs.get(ID)!;
    expect(after.batchId).toBe('batch-new');
    expect(after.reclaimedFrom).toBe('batch-killed');
    expect(after.driveFileId).toBeUndefined();
  });

  it('does not reclaim a stale claim that DID produce a Drive file', async () => {
    // Age alone must never win: if the bytes are in Drive it is a real duplicate.
    docs.set(ID, { driveFileId: 'drive-1', claimedAt: minutesAgo(10_000), batchId: 'batch-old' });
    expect(await claimUploadedFile(INPUT)).toBe(false);
  });

  it('treats a claim with no timestamp as owned rather than guessing', async () => {
    docs.set(ID, { batchId: 'batch-mystery' });
    expect(await claimUploadedFile(INPUT)).toBe(false);
  });

  it('accepts a Firestore Timestamp, not just a Date', async () => {
    const d = minutesAgo(120);
    docs.set(ID, { claimedAt: { toDate: () => d }, batchId: 'batch-killed' });
    expect(await claimUploadedFile(INPUT)).toBe(true);
  });

  it('wins the key if the claim vanished under it', async () => {
    // create() saw ALREADY_EXISTS but the doc is gone by the time we look.
    createError = Object.assign(new Error('6 ALREADY_EXISTS'), { code: 6 });
    expect(await claimUploadedFile(INPUT)).toBe(true);
  });

  it('fails CLOSED when the staleness check itself errors', async () => {
    // We already know a claim exists; the safe reading of an unreadable one is
    // "someone owns it" rather than risking a second copy into Drive.
    docs.set(ID, { claimedAt: minutesAgo(120), batchId: 'batch-killed' });
    txFails = true;
    expect(await claimUploadedFile(INPUT)).toBe(false);
  });

  it('fails OPEN on an unexpected create error, so an outage cannot drop photos', async () => {
    createError = Object.assign(new Error('14 UNAVAILABLE'), { code: 14 });
    expect(await claimUploadedFile(INPUT)).toBe(true);
  });
});
