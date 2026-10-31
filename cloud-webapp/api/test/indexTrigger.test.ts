/**
 * triggerIndexJobUnlessInFlight — the claim must be atomic and a failed trigger
 * must hand the slot back, or the event reads as `queued` for the whole stale
 * window and index-scan skips it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const events = new Map<string, Record<string, unknown>>();
function merge(id: string, data: Record<string, unknown>): void {
  const prev = events.get(id) ?? {};
  const next = data.indexState as Record<string, unknown> | undefined;
  events.set(id, {
    ...prev,
    ...data,
    ...(next ? { indexState: { ...((prev.indexState ?? {}) as Record<string, unknown>), ...next } } : {}),
  });
}

vi.mock('../src/lib/firestore.js', () => ({
  firestore: () => ({
    collection: () => ({
      doc: (id: string) => ({ __id: id, set: async (d: Record<string, unknown>) => merge(id, d) }),
    }),
    runTransaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> =>
      fn({
        get: async (ref: { __id: string }) => ({ data: () => events.get(ref.__id) }),
        set: (ref: { __id: string }, d: Record<string, unknown>) => merge(ref.__id, d),
      }),
  }),
}));

const triggerIndexJob = vi.fn(async (_eventId: string) => ({ execution: 'exec-1' }));
vi.mock('../src/services/indexerJob.js', () => ({
  triggerIndexJob: (eventId: string) => triggerIndexJob(eventId),
}));

const { triggerIndexJobUnlessInFlight } = await import('../src/services/indexTrigger.js');

const state = (id: string) => events.get(id)?.indexState as Record<string, unknown> | undefined;

beforeEach(() => {
  events.clear();
  triggerIndexJob.mockReset();
  triggerIndexJob.mockResolvedValue({ execution: 'exec-1' });
});

describe('triggerIndexJobUnlessInFlight', () => {
  it('claims the slot as queued and triggers', async () => {
    events.set('ev', { indexState: { status: 'done', updatedAt: '2026-01-01T00:00:00Z', processed: 7 } });
    await expect(triggerIndexJobUnlessInFlight('ev')).resolves.toEqual({ triggered: true, execution: 'exec-1' });
    expect(state('ev')).toMatchObject({ status: 'queued', processed: 7 });
  });

  it('skips without triggering while a fresh run is in flight', async () => {
    events.set('ev', { indexState: { status: 'running', updatedAt: new Date().toISOString() } });
    await expect(triggerIndexJobUnlessInFlight('ev')).resolves.toEqual({ triggered: false, reason: 'already_running' });
    expect(triggerIndexJob).not.toHaveBeenCalled();
  });

  it('only the first of two back-to-back callers triggers', async () => {
    await triggerIndexJobUnlessInFlight('ev');
    await triggerIndexJobUnlessInFlight('ev');
    expect(triggerIndexJob).toHaveBeenCalledTimes(1);
  });

  it('restores the prior state when the trigger fails', async () => {
    const prior = { status: 'done', updatedAt: '2026-01-01T00:00:00Z' };
    events.set('ev', { indexState: { ...prior } });
    triggerIndexJob.mockRejectedValueOnce(new Error('jobs api 503'));
    await expect(triggerIndexJobUnlessInFlight('ev')).rejects.toThrow('jobs api 503');
    expect(state('ev')).toMatchObject(prior);
  });

  it('records failed (not in flight) when a never-indexed event fails to trigger', async () => {
    triggerIndexJob.mockRejectedValueOnce(new Error('jobs api 503'));
    await expect(triggerIndexJobUnlessInFlight('ev')).rejects.toThrow();
    expect(state('ev')).toMatchObject({ status: 'failed' });
    // …so the very next caller is allowed to try again.
    await expect(triggerIndexJobUnlessInFlight('ev')).resolves.toMatchObject({ triggered: true });
  });
});
