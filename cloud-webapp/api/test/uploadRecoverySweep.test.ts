/**
 * uploadRecoverySweep — the hourly backstop for volunteer photos stranded in
 * staging.
 *
 * WHAT THIS PROTECTS: the copy path keeps a photo in staging whenever it cannot
 * prove the photo reached Drive, and before this sweep nothing came back for it.
 * The rules below decide when coming back is safe. The dangerous mistake is
 * re-dispatching a batch whose chunk chain is still alive — recovery writes into
 * its own Drive folder, so that would split a photographer's session — which is
 * why every "unknown" must read as "leave it for next hour".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.ADMIN_EMAILS = 'boss@example.org, ops@example.org';

const listAllStaged = vi.fn();
const strandedObjects = vi.fn();
const dispatchStagedRecovery = vi.fn();
vi.mock('../src/services/uploadRecoveryService.js', () => ({
  listAllStaged: () => listAllStaged(),
  strandedObjects: (eventId: string) => strandedObjects(eventId),
  dispatchStagedRecovery: (eventId: string, opts: unknown) => dispatchStagedRecovery(eventId, opts),
}));

const batchDocs = new Map<string, Record<string, unknown>>();
vi.mock('../src/services/uploadBatchService.js', () => ({
  getUploadBatch: async (id: string) => batchDocs.get(id) ?? null,
}));

const processBatchTaskExists = vi.fn();
vi.mock('../src/services/uploadDispatch.js', () => ({
  processBatchTaskExists: (id: string) => processBatchTaskExists(id),
}));

const sendToMany = vi.fn();
vi.mock('../src/services/emailService.js', () => ({
  sendToMany: (to: string[], content: unknown) => sendToMany(to, content),
}));

// The alert throttle doc (ops_state/upload_recovery_sweep).
let alertState: Record<string, unknown> | undefined;
let alertStateReadFails = false;
vi.mock('../src/lib/firestore.js', () => ({
  firestore: () => ({
    collection: () => ({
      doc: () => ({
        get: async () => {
          if (alertStateReadFails) throw new Error('firestore down');
          return { data: () => alertState };
        },
        set: async (data: Record<string, unknown>) => {
          alertState = { ...alertState, ...data };
        },
      }),
    }),
  }),
}));

const {
  judgeBatch,
  sweepStagedUploads,
  ACTIVE_GRACE_MS,
  NO_TASK_DEAD_AFTER_MS,
  TERMINAL_SETTLE_MS,
  NO_DOC_MIN_AGE_MS,
  RECOVERY_COOLDOWN_MS,
  ALERT_AFTER_MS,
  ALERT_EVERY_MS,
} = await import('../src/services/uploadRecoverySweep.js');

const NOW = Date.parse('2026-11-01T14:20:00.000Z');
const ago = (ms: number): string => new Date(NOW - ms).toISOString();
const MIN = 60_000;

type Staged = Parameters<typeof judgeBatch>[0]['objects'][number];
function staged(eventId: string, batchId: string, id: string, createdAt = ago(MIN)): Staged {
  return {
    name: `volunteer_uploads/${eventId}/${batchId}/${id}.jpg`,
    md5Hex: '',
    size: 5_000_000,
    eventId,
    batchId,
    linkId: 'link-1',
    clubName: 'ClubA',
    photographerName: 'Jane',
    createdAt,
  };
}

function doc(patch: Record<string, unknown>): Parameters<typeof judgeBatch>[0]['doc'] {
  return {
    batchId: 'b1',
    eventId: 'ev1',
    linkId: 'link-1',
    phase: 'saving',
    total: 10,
    copied: 0,
    skippedDuplicates: 0,
    skippedDuplicateNames: [],
    failed: 0,
    batchFolderName: '',
    createdAt: ago(3 * 3_600_000),
    updatedAt: ago(MIN),
    ...patch,
  } as Parameters<typeof judgeBatch>[0]['doc'];
}

const OBJS = [staged('ev1', 'b1', 'a')];
const judge = (d: Parameters<typeof judgeBatch>[0]['doc'], extra: Partial<Parameters<typeof judgeBatch>[0]> = {}) =>
  judgeBatch({ doc: d, objects: OBJS, taskAlive: null, lookupFailed: false, now: NOW, ...extra });

// ── the rules ────────────────────────────────────────────────────────────────

describe('judgeBatch — a batch still being worked on is never re-dispatched', () => {
  it('leaves a batch whose task is still in the queue alone, however long it has run', () => {
    expect(judge(doc({ pendingTask: 'b1-c7', updatedAt: ago(5 * 3_600_000) }), { taskAlive: true })).toBe('active');
  });

  it('gives a chain whose task just finished the hand-off grace', () => {
    // The doc can name a finished chunk for a moment while its successor runs.
    expect(judge(doc({ pendingTask: 'b1-c2', updatedAt: ago(ACTIVE_GRACE_MS - MIN) }), { taskAlive: false })).toBe(
      'active',
    );
  });

  it('recovers a chain whose task is gone and that has gone silent', () => {
    expect(judge(doc({ pendingTask: 'b1-c2', updatedAt: ago(ACTIVE_GRACE_MS + MIN) }), { taskAlive: false })).toBe(
      'recover',
    );
  });

  it('never reads a failed queue lookup as "dead"', () => {
    expect(judge(doc({ pendingTask: 'b1', updatedAt: ago(10 * 3_600_000) }), { lookupFailed: true })).toBe('active');
  });

  it('presumes a batch with no recorded task alive for two hours (pre-chunking batches)', () => {
    expect(judge(doc({ updatedAt: ago(NO_TASK_DEAD_AFTER_MS - MIN) }))).toBe('active');
    expect(judge(doc({ updatedAt: ago(NO_TASK_DEAD_AFTER_MS + MIN) }))).toBe('recover');
  });

  it("treats a missing write time as just written", () => {
    expect(judge(doc({ updatedAt: undefined }))).toBe('active');
  });
});

describe('judgeBatch — finished batches', () => {
  it('waits out the stale-claim reclaim before re-sending the leftovers', () => {
    // Before 35 minutes a dead worker's claim is still fresh, so a re-sent copy
    // would just be skipped as a duplicate again.
    expect(TERMINAL_SETTLE_MS).toBeGreaterThan(35 * MIN);
    expect(judge(doc({ phase: 'indexing', updatedAt: ago(TERMINAL_SETTLE_MS - MIN) }))).toBe('settling');
    expect(judge(doc({ phase: 'indexing', updatedAt: ago(TERMINAL_SETTLE_MS + MIN) }))).toBe('recover');
    expect(judge(doc({ phase: 'done', updatedAt: ago(TERMINAL_SETTLE_MS + MIN) }))).toBe('recover');
  });

  it('leaves a recently recovered batch alone while its spaced-out tasks come due', () => {
    const d = doc({ phase: 'indexing', updatedAt: ago(5 * 3_600_000), lastRecoveryAt: ago(RECOVERY_COOLDOWN_MS - MIN) });
    expect(judge(d)).toBe('cooldown');
    expect(judge({ ...d!, lastRecoveryAt: ago(RECOVERY_COOLDOWN_MS + MIN) })).toBe('recover');
  });
});

describe('judgeBatch — objects with no batch doc (a session that never called /complete)', () => {
  it('leaves them alone while any object is under six hours old — the volunteer may still be uploading', () => {
    const objects = [staged('ev1', 'b1', 'a', ago(NO_DOC_MIN_AGE_MS + MIN)), staged('ev1', 'b1', 'b', ago(MIN))];
    expect(judgeBatch({ doc: null, objects, taskAlive: null, lookupFailed: false, now: NOW })).toBe('young');
  });

  it('treats an unknown creation time as young', () => {
    const objects = [staged('ev1', 'b1', 'a', '')];
    expect(judgeBatch({ doc: null, objects, taskAlive: null, lookupFailed: false, now: NOW })).toBe('young');
  });

  it('recovers them once every object is provably old', () => {
    const objects = [staged('ev1', 'b1', 'a', ago(NO_DOC_MIN_AGE_MS + MIN))];
    expect(judgeBatch({ doc: null, objects, taskAlive: null, lookupFailed: false, now: NOW })).toBe('recover');
  });

  it('applies the same rule to a doc that holds only an expired recovery stamp', () => {
    const stampOnly = { lastRecoveryAt: ago(RECOVERY_COOLDOWN_MS + MIN) } as unknown as Parameters<typeof judgeBatch>[0]['doc'];
    expect(judgeBatch({ doc: stampOnly, objects: OBJS, taskAlive: null, lookupFailed: false, now: NOW })).toBe('young');
  });
});

// ── the sweep ────────────────────────────────────────────────────────────────

beforeEach(() => {
  listAllStaged.mockReset();
  strandedObjects.mockReset();
  dispatchStagedRecovery.mockReset().mockImplementation(async (_ev: string, opts: { startDelayMs?: number; batchIds?: string[] }) => ({
    eventId: _ev,
    apply: false,
    objects: opts.batchIds?.length ?? 0,
    tasks: opts.batchIds?.length ?? 0,
    batches: opts.batchIds?.length ?? 0,
    notDispatched: 0,
    estimatedMinutes: 1,
    scheduledThroughMs: (opts.startDelayMs ?? 0) + 60_000,
    warnings: [],
  }));
  processBatchTaskExists.mockReset();
  sendToMany.mockReset().mockResolvedValue(2);
  batchDocs.clear();
  alertState = undefined;
  alertStateReadFails = false;
});

/** Stage these objects, all counted as stranded (not yet in the photo index). */
function stageAll(objects: Staged[]): void {
  listAllStaged.mockResolvedValue(objects);
  strandedObjects.mockImplementation(async (eventId: string) => {
    const mine = objects.filter((o) => o.eventId === eventId);
    return { all: mine, stranded: mine };
  });
}

describe('sweepStagedUploads', () => {
  it('re-dispatches only the batches nothing else is working on', async () => {
    stageAll([staged('ev1', 'dead', 'a'), staged('ev1', 'live', 'b'), staged('ev1', 'fresh', 'c')]);
    batchDocs.set('dead', { phase: 'saving', pendingTask: 'dead-c3', updatedAt: ago(ACTIVE_GRACE_MS + MIN) });
    batchDocs.set('live', { phase: 'saving', pendingTask: 'live-c1', updatedAt: ago(ACTIVE_GRACE_MS + MIN) });
    batchDocs.set('fresh', { phase: 'indexing', updatedAt: ago(MIN) });
    processBatchTaskExists.mockImplementation(async (id: string) => id === 'live-c1');

    const out = await sweepStagedUploads({ apply: true, now: new Date(NOW) });

    expect(out.batches).toMatchObject({ recover: 1, active: 1, settling: 1 });
    expect(dispatchStagedRecovery).toHaveBeenCalledTimes(1);
    expect(dispatchStagedRecovery).toHaveBeenCalledWith('ev1', {
      apply: true,
      batchIds: ['dead'],
      runTag: '20261101t142000',
      startDelayMs: 0,
    });
    // Only in-flight batches cost a queue lookup.
    expect(processBatchTaskExists.mock.calls.map((c) => c[0]).sort()).toEqual(['dead-c3', 'live-c1']);
  });

  it("queues each event's recovery behind the previous event's", async () => {
    stageAll([staged('ev1', 'b1', 'a'), staged('ev2', 'b2', 'b')]);
    batchDocs.set('b1', { phase: 'done', updatedAt: ago(TERMINAL_SETTLE_MS + MIN) });
    batchDocs.set('b2', { phase: 'done', updatedAt: ago(TERMINAL_SETTLE_MS + MIN) });

    await sweepStagedUploads({ apply: true, now: new Date(NOW) });

    const delays = dispatchStagedRecovery.mock.calls.map((c) => (c[1] as { startDelayMs: number }).startDelayMs);
    expect(delays).toEqual([0, 60_000]);
  });

  it('is a dry run unless apply is exactly true', async () => {
    stageAll([staged('ev1', 'b1', 'a', ago(ALERT_AFTER_MS + MIN))]);
    batchDocs.set('b1', { phase: 'done', updatedAt: ago(TERMINAL_SETTLE_MS + MIN) });

    const out = await sweepStagedUploads({ now: new Date(NOW) });

    expect(out.apply).toBe(false);
    expect((dispatchStagedRecovery.mock.calls[0]?.[1] as { apply: boolean }).apply).toBe(false);
    expect(sendToMany).not.toHaveBeenCalled();
    expect(out.overdue.objects).toBe(1); // still reported
  });

  it('leaves a batch alone when its doc cannot be read', async () => {
    stageAll([staged('ev1', 'b1', 'a')]);
    batchDocs.set('b1', { phase: 'done', updatedAt: ago(TERMINAL_SETTLE_MS + MIN) });
    const spy = vi.spyOn(batchDocs, 'get').mockImplementation(() => {
      throw new Error('firestore down');
    });

    const out = await sweepStagedUploads({ apply: true, now: new Date(NOW) });
    spy.mockRestore();

    expect(out.batches.active).toBe(1);
    expect(dispatchStagedRecovery).not.toHaveBeenCalled();
    expect(out.warnings[0]).toMatch(/could not read the batch doc/);
  });

  it('skips an event whose photo index cannot be read, and carries on', async () => {
    listAllStaged.mockResolvedValue([staged('ev1', 'b1', 'a'), staged('ev2', 'b2', 'b')]);
    strandedObjects.mockImplementation(async (eventId: string) => {
      if (eventId === 'ev1') throw new Error('index down');
      return { all: [staged('ev2', 'b2', 'b')], stranded: [staged('ev2', 'b2', 'b')] };
    });
    batchDocs.set('b2', { phase: 'done', updatedAt: ago(TERMINAL_SETTLE_MS + MIN) });

    const out = await sweepStagedUploads({ apply: true, now: new Date(NOW) });

    expect(dispatchStagedRecovery.mock.calls.map((c) => c[0])).toEqual(['ev2']);
    expect(out.warnings[0]).toMatch(/^ev1: could not read the photo index/);
  });
});

describe('sweepStagedUploads — alerting when the sweep is not fixing it', () => {
  function overdueBatch(): void {
    stageAll([staged('ev1', 'b1', 'a', ago(ALERT_AFTER_MS + 3 * 3_600_000)), staged('ev1', 'b1', 'b', ago(MIN))]);
    batchDocs.set('b1', { phase: 'done', updatedAt: ago(TERMINAL_SETTLE_MS + MIN) });
  }

  it('emails every super-admin about photos stranded over a day', async () => {
    overdueBatch();

    const out = await sweepStagedUploads({ apply: true, now: new Date(NOW) });

    expect(out.overdue).toEqual({ objects: 1, oldestHours: 27, events: [{ eventId: 'ev1', objects: 1 }] });
    expect(out.alerted).toBe(true);
    expect(sendToMany).toHaveBeenCalledTimes(1);
    const [to, content] = sendToMany.mock.calls[0] as [string[], { subject: string; text: string }];
    expect(to).toEqual(['boss@example.org', 'ops@example.org']);
    expect(content.subject).toMatch(/1 volunteer photo not reaching Drive/);
    expect(content.text).toMatch(/ev1: 1/);
    expect(alertState?.lastAlertAt).toBe(new Date(NOW).toISOString());
  });

  it('does not email again within twelve hours', async () => {
    overdueBatch();
    alertState = { lastAlertAt: ago(ALERT_EVERY_MS - MIN) };

    const out = await sweepStagedUploads({ apply: true, now: new Date(NOW) });

    expect(out.alerted).toBe(false);
    expect(sendToMany).not.toHaveBeenCalled();
  });

  it('emails again once the window has passed', async () => {
    overdueBatch();
    alertState = { lastAlertAt: ago(ALERT_EVERY_MS + MIN) };
    expect((await sweepStagedUploads({ apply: true, now: new Date(NOW) })).alerted).toBe(true);
  });

  it('sends anyway when the throttle cannot be read — a silent week is the expensive failure', async () => {
    overdueBatch();
    alertStateReadFails = true;
    expect((await sweepStagedUploads({ apply: true, now: new Date(NOW) })).alerted).toBe(true);
  });

  it('does not record an alert that nobody received', async () => {
    overdueBatch();
    sendToMany.mockResolvedValue(0); // EMAIL_ENABLED off, or every send failed

    const out = await sweepStagedUploads({ apply: true, now: new Date(NOW) });

    expect(out.alerted).toBe(false);
    expect(alertState).toBeUndefined();
  });

  it('stays quiet while nothing is over a day old', async () => {
    stageAll([staged('ev1', 'b1', 'a', ago(ALERT_AFTER_MS - MIN))]);
    batchDocs.set('b1', { phase: 'done', updatedAt: ago(TERMINAL_SETTLE_MS + MIN) });

    const out = await sweepStagedUploads({ apply: true, now: new Date(NOW) });

    expect(out.overdue.objects).toBe(0);
    expect(sendToMany).not.toHaveBeenCalled();
  });
});
