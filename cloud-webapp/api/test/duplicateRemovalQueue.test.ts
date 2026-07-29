/**
 * duplicateRemovalQueue — the bounded drain that replaced the inline removal.
 *
 * THE BUG THESE GUARD: removing an event's duplicates is minutes of rate-paced
 * Drive work (~3.5 paced calls per file once its managed shortcuts are retired).
 * Done inline it blew the 60s request ceiling on every call — one field run logged
 * `totalMs=325833` against a 45s "budget" — so the admin only ever saw HTTP 502
 * while files were silently being trashed. The invariants below are what make the
 * work resumable instead: a tick is bounded, progress is committed per chunk, the
 * sweep queue survives a cut-short sweep, and the batch is only "done" when both
 * queues are empty.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
// Type-only, so it is erased before vi.mock hoisting can care about it.
import type * as ConfigModule from '../src/lib/config.js';

const walkMediaFiles = vi.fn();
const getDriveToken = vi.fn();
vi.mock('../src/services/driveService.js', () => ({
  walkMediaFiles: (...a: unknown[]) => walkMediaFiles(...a),
  getDriveToken: (...a: unknown[]) => getDriveToken(...a),
  DRIVE_SCOPE_READWRITE: 'https://www.googleapis.com/auth/drive',
}));

const trashDriveFile = vi.fn();
vi.mock('../src/services/driveShortcutClient.js', () => ({
  trashDriveFile: (...a: unknown[]) => trashDriveFile(...a),
}));

const recordSoftDeletes = vi.fn();
vi.mock('../src/services/deletedFilesStore.js', () => ({
  recordSoftDeletes: (...a: unknown[]) => recordSoftDeletes(...a),
}));

const removeShortcutsForTargets = vi.fn();
vi.mock('../src/services/specialFoldersService.js', () => ({
  removeShortcutsForTargets: (...a: unknown[]) => removeShortcutsForTargets(...a),
  isManagedFolderName: (n: string) => n === 'Videos' || n === 'Album' || n.startsWith('Photos_'),
  isVideoFile: (m: string) => m === 'video/mp4',
}));

const tryRebuildPublicFolderIndex = vi.fn();
vi.mock('../src/services/publicFolderIndexService.js', () => ({
  tryRebuildPublicFolderIndex: () => tryRebuildPublicFolderIndex(),
}));

// Mutable so a test can drop MASTER_SPREADSHEET_ID / turn managed folders off.
// Partial mock: the rest of config (isProd, …) is still needed by the logger.
const env = { MASTER_SPREADSHEET_ID: 'sheet1', MANAGED_FOLDERS_ENABLED: 'true' };
vi.mock('../src/lib/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof ConfigModule>()),
  env,
}));

// ── Minimal in-memory Firestore ───────────────────────────────────────────────
// Enough of the surface the queue uses: auto-id docs, get/set/update, a
// where+orderBy+limit query, and runTransaction with tx.get/tx.update. Documents
// are deep-cloned in and out so a test can never accidentally share array
// references with the code under test (which is exactly how a lost-update bug
// would hide).
type Doc = Record<string, unknown>;
const store = new Map<string, Doc>();
let autoId = 0;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function snapshotOf(key: string, id: string) {
  const data = store.get(key);
  return {
    id,
    exists: data !== undefined,
    data: () => (data === undefined ? undefined : clone(data)),
    get: (field: string) => (data === undefined ? undefined : clone(data[field])),
  };
}

function docRef(collection: string, id: string) {
  const key = `${collection}/${id}`;
  return {
    id,
    __key: key,
    get: async () => snapshotOf(key, id),
    set: async (data: Doc) => void store.set(key, clone(data)),
    update: async (patch: Doc) => void store.set(key, { ...(store.get(key) ?? {}), ...clone(patch) }),
  };
}

interface FakeQuery {
  where(field: string, op: string, value: unknown): FakeQuery;
  orderBy(field: string, dir?: 'asc' | 'desc'): FakeQuery;
  limit(n: number): FakeQuery;
  doc(id?: string): ReturnType<typeof docRef>;
  get(): Promise<{ docs: Array<{ id: string; data: () => Doc; get: (f: string) => unknown }> }>;
}

function collectionRef(collection: string): FakeQuery {
  const filters: Array<[string, unknown]> = [];
  let order: { field: string; dir: 'asc' | 'desc' } | null = null;
  let cap = Infinity;
  const q: Record<string, unknown> = {
    where(field: string, _op: string, value: unknown) {
      filters.push([field, value]);
      return q;
    },
    orderBy(field: string, dir: 'asc' | 'desc' = 'asc') {
      order = { field, dir };
      return q;
    },
    limit(n: number) {
      cap = n;
      return q;
    },
    doc(id?: string) {
      return docRef(collection, id ?? `auto${++autoId}`);
    },
    async get() {
      let rows = [...store.entries()]
        .filter(([k]) => k.startsWith(`${collection}/`))
        .map(([k, v]) => ({ id: k.slice(collection.length + 1), data: v }));
      for (const [field, value] of filters) rows = rows.filter((r) => r.data[field] === value);
      if (order) {
        const { field, dir } = order;
        rows.sort((a, b) => String(a.data[field]).localeCompare(String(b.data[field])) * (dir === 'desc' ? -1 : 1));
      }
      rows = rows.slice(0, cap);
      return { docs: rows.map((r) => ({ id: r.id, data: () => clone(r.data), get: (f: string) => clone(r.data[f]) })) };
    },
  };
  return q as unknown as FakeQuery;
}

const fakeFirestore = () => ({
  collection: (name: string) => collectionRef(name) as never,
  runTransaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
    const tx = {
      get: async (ref: { __key: string; id: string }) => snapshotOf(ref.__key, ref.id),
      update: (ref: { __key: string }, patch: Doc) =>
        void store.set(ref.__key, { ...(store.get(ref.__key) ?? {}), ...clone(patch) }),
    };
    return fn(tx);
  },
});
vi.mock('../src/lib/firestore.js', () => ({ firestore: () => fakeFirestore() }));

const {
  enqueueDuplicateRemoval,
  drainDuplicateRemovalQueue,
  getDuplicateBatch,
  latestDuplicateBatch,
} = await import('../src/services/duplicateRemovalQueue.js');

const file = (id: string, relPath: string, md5?: string, size = '100') => ({
  id,
  name: relPath.split('/').pop()!,
  mimeType: 'image/jpeg',
  ...(md5 === undefined ? {} : { md5Checksum: md5 }),
  relPath,
  size,
});

/** One md5 group of `n + 1` files: the canonical plus `n` removable duplicates. */
function dupes(n: number) {
  return [
    file('keep', 'Club/t/b/000.jpg', 'dup', '400'),
    ...Array.from({ length: n }, (_, i) =>
      file(`dup${i}`, `Club/t/b/${String(i + 1).padStart(3, '0')}.jpg`, 'dup', '400'),
    ),
  ];
}

const okSweep = { shortcutsRemoved: 0, foldersTouched: 0, errors: [], completed: true };

beforeEach(() => {
  store.clear();
  autoId = 0;
  env.MASTER_SPREADSHEET_ID = 'sheet1';
  env.MANAGED_FOLDERS_ENABLED = 'true';
  walkMediaFiles.mockReset().mockResolvedValue([]);
  getDriveToken.mockReset().mockResolvedValue('tok');
  trashDriveFile.mockReset().mockResolvedValue({ ok: true, status: 200 });
  recordSoftDeletes.mockReset().mockResolvedValue([{ deleteId: 'd1' }]);
  removeShortcutsForTargets.mockReset().mockResolvedValue({ ...okSweep });
  tryRebuildPublicFolderIndex.mockReset().mockResolvedValue(undefined);
  store.set('events/ev1', { driveFolderId: 'root1', name: 'Spring Meet' });
});

describe('enqueueDuplicateRemoval', () => {
  it('queues the scanned duplicates and trashes NOTHING inline', async () => {
    walkMediaFiles.mockResolvedValue(dupes(3));
    const out = await enqueueDuplicateRemoval('ev1', { createdBy: 'a@x.org' });
    expect(out.ok).toBe(true);
    expect(out.data!.total).toBe(3);
    expect(out.data!.notEnqueued).toBe(0);
    // The whole point: enqueuing is cheap, so no Drive writes happen here.
    expect(trashDriveFile).not.toHaveBeenCalled();
    expect(recordSoftDeletes).not.toHaveBeenCalled();

    const batch = await getDuplicateBatch(out.data!.id);
    expect(batch!.status).toBe('running');
    expect(batch!.pending).toHaveLength(3);
    expect(batch!.eventName).toBe('Spring Meet');
  });

  it('reports "no work" without writing a batch when there are no duplicates', async () => {
    walkMediaFiles.mockResolvedValue([file('only', 'Club/t/b/1.jpg', 'h')]);
    const out = await enqueueDuplicateRemoval('ev1', { createdBy: 'a@x.org' });
    expect(out.ok).toBe(true);
    expect(out.data).toBeUndefined();
    expect(await latestDuplicateBatch()).toBeNull();
  });

  it('never queues the canonical copy', async () => {
    walkMediaFiles.mockResolvedValue(dupes(2));
    const out = await enqueueDuplicateRemoval('ev1', { createdBy: 'a@x.org' });
    const batch = await getDuplicateBatch(out.data!.id);
    expect(batch!.pending.map((p) => p.i)).toEqual(['dup0', 'dup1']);
  });

  it('caps a huge event and reports the overflow instead of dropping it', async () => {
    walkMediaFiles.mockResolvedValue(dupes(1600));
    const out = await enqueueDuplicateRemoval('ev1', { createdBy: 'a@x.org' });
    // ENQUEUE_CAP keeps the batch doc under Firestore's 1 MiB limit.
    expect(out.data!.total).toBe(1500);
    expect(out.data!.notEnqueued).toBe(100);
    expect(out.message).toContain('run again');
  });

  it('confines a club_admin to their own club', async () => {
    walkMediaFiles.mockResolvedValue([
      file('mine1', 'Blue/t/b/1.jpg', 'dup'),
      file('mine2', 'Blue/t/b/2.jpg', 'dup'),
      file('theirs1', 'Red/t/b/1.jpg', 'dup'),
      file('theirs2', 'Red/t/b/2.jpg', 'dup'),
    ]);
    const out = await enqueueDuplicateRemoval('ev1', { createdBy: 'a@x.org', clubScope: 'Blue' });
    const batch = await getDuplicateBatch(out.data!.id);
    expect(batch!.pending.map((p) => p.i)).toEqual(['mine2']);
  });
});

describe('drainDuplicateRemovalQueue', () => {
  async function queue(n: number): Promise<string> {
    walkMediaFiles.mockResolvedValue(dupes(n));
    const out = await enqueueDuplicateRemoval('ev1', { createdBy: 'a@x.org' });
    return out.data!.id;
  }

  it('is a cheap no-op when nothing is queued', async () => {
    const out = await drainDuplicateRemovalQueue();
    expect(out.drained).toBe(false);
    expect(getDriveToken).not.toHaveBeenCalled();
    expect(trashDriveFile).not.toHaveBeenCalled();
  });

  it('drains a small batch to done and refreshes the public index exactly once', async () => {
    const id = await queue(3);
    const out = await drainDuplicateRemovalQueue();
    expect(out.processed).toBe(3);
    expect(out.remaining).toBe(0);
    expect(out.finished).toBe(true);
    const batch = await getDuplicateBatch(id);
    expect(batch!.status).toBe('done');
    expect(batch!.removed).toBe(3);
    expect(batch!.bytesReclaimed).toBe(1200);
    expect(batch!.finishedAt).toBeTruthy();
    expect(tryRebuildPublicFolderIndex).toHaveBeenCalledTimes(1);
  });

  it('caps files per tick so one tick can never run to the request ceiling', async () => {
    const id = await queue(70);
    const first = await drainDuplicateRemovalQueue();
    // MAX_FILES_PER_TICK — the tick stops on the cap, not on the clock.
    expect(first.processed).toBe(60);
    expect(first.finished).toBe(false);
    expect((await getDuplicateBatch(id))!.pending).toHaveLength(10);

    const second = await drainDuplicateRemovalQueue();
    expect(second.processed).toBe(10);
    expect(second.finished).toBe(true);
    expect((await getDuplicateBatch(id))!.removed).toBe(70);
  });

  it('stops on its deadline and leaves the rest queued', async () => {
    const id = await queue(70);
    trashDriveFile.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return { ok: true, status: 200 };
    });
    const started = Date.now();
    const out = await drainDuplicateRemovalQueue(60);
    // Bounded: nowhere near the 60s ceiling that used to kill the request.
    expect(Date.now() - started).toBeLessThan(2000);
    // One chunk always runs, so a spent budget still makes forward progress
    // rather than stalling the batch forever.
    expect(out.processed).toBe(10);
    const batch = await getDuplicateBatch(id);
    // Nothing is lost — what wasn't done is still queued.
    expect(batch!.removed + batch!.pending.length).toBe(70);
    expect(batch!.status).toBe('running');
  });

  it('commits progress per chunk, so a tick that dies keeps what it trashed', async () => {
    const id = await queue(30);
    // Blow up on the 3rd chunk: the first two must already be committed.
    let calls = 0;
    trashDriveFile.mockImplementation(async () => {
      calls += 1;
      if (calls > 20) throw new Error('drive exploded');
      return { ok: true, status: 200 };
    });
    const out = await drainDuplicateRemovalQueue();
    expect(out.processed).toBe(20);
    const batch = await getDuplicateBatch(id);
    expect(batch!.removed).toBe(20);
    expect(batch!.pending).toHaveLength(10);
    expect(batch!.status).toBe('running');
    expect(batch!.warnings.join(' ')).toContain('drive exploded');
    // Still resumable on the next tick.
    trashDriveFile.mockResolvedValue({ ok: true, status: 200 });
    const again = await drainDuplicateRemovalQueue();
    expect(again.finished).toBe(true);
    expect((await getDuplicateBatch(id))!.removed).toBe(30);
  });

  it('gives the sweep a deadline and scopes it to the event', async () => {
    await queue(2);
    await drainDuplicateRemovalQueue();
    const [targets, opts] = removeShortcutsForTargets.mock.calls[0]! as [string[], { eventId: string; deadlineMs: number }];
    expect(targets).toEqual(['dup0', 'dup1']);
    expect(opts.eventId).toBe('ev1');
    // Unbounded, this sweep is what actually overran the 60s ceiling.
    expect(opts.deadlineMs).toBeGreaterThan(Date.now() - 1000);
  });

  it('keeps the batch open when the sweep was cut short, and finishes it next tick', async () => {
    const id = await queue(2);
    removeShortcutsForTargets.mockResolvedValueOnce({ ...okSweep, shortcutsRemoved: 1, completed: false });
    const first = await drainDuplicateRemovalQueue();
    expect(first.finished).toBe(false);
    let batch = await getDuplicateBatch(id);
    // Files are trashed, but their managed entries are still owed work.
    expect(batch!.pending).toHaveLength(0);
    expect(batch!.pendingSweep).toEqual(['dup0', 'dup1']);
    expect(batch!.status).toBe('running');
    expect(tryRebuildPublicFolderIndex).not.toHaveBeenCalled();

    // Next tick re-runs the (idempotent) sweep and only then completes.
    const second = await drainDuplicateRemovalQueue();
    expect(second.finished).toBe(true);
    batch = await getDuplicateBatch(id);
    expect(batch!.pendingSweep).toEqual([]);
    expect(batch!.status).toBe('done');
    expect(tryRebuildPublicFolderIndex).toHaveBeenCalledTimes(1);
  });

  it('reports the two queues separately so progress is never hidden', async () => {
    // THE BUG THIS GUARDS: `remaining` used to be pending + pendingSweep, and
    // trashing a file just moves it between those lists — so the number sat dead
    // still (a flat 1239 for the first four ticks of a real 1,239-file batch)
    // while files were being removed the whole time. A run that was working read
    // as a hang. `remaining` is queued-to-trash ONLY; sweep backlog is its own
    // field, and removed/total is the honest progress figure.
    await queue(2);
    removeShortcutsForTargets.mockResolvedValueOnce({ ...okSweep, shortcutsRemoved: 1, completed: false });
    const cutShort = await drainDuplicateRemovalQueue();
    expect(cutShort.remaining).toBe(0); // nothing left to trash …
    expect(cutShort.sweepRemaining).toBe(2); // … but the sweep still owes work
    expect(cutShort.finished).toBe(false);
    // The summed version reported 2 here and was indistinguishable from
    // "2 files still untrashed".
    expect(cutShort.removed).toBe(2);
    expect(cutShort.total).toBe(2);

    const done = await drainDuplicateRemovalQueue();
    expect(done.remaining).toBe(0);
    expect(done.sweepRemaining).toBe(0);
    expect(done.finished).toBe(true);
  });

  it('reports cumulative removed/total, counting files another drainer trashed', async () => {
    // The scheduler drains the same batch every 2 minutes, so a caller that sums
    // its OWN ticks undercounts — that is why a run which removed 1,444 files
    // reported "1434 trashed". `removed` is the batch's cumulative tally.
    const id = await queue(70);
    const first = await drainDuplicateRemovalQueue();
    expect(first.processed).toBe(60); // this tick
    expect(first.removed).toBe(60); // batch so far
    expect(first.total).toBe(70);
    expect(first.remaining).toBe(10);

    const second = await drainDuplicateRemovalQueue();
    expect(second.processed).toBe(10); // only 10 in THIS tick …
    expect(second.removed).toBe(70); // … but 70 for the batch
    expect(second.total).toBe(70);
    expect(second.finished).toBe(true);
    expect((await getDuplicateBatch(id))!.removed).toBe(70);
  });

  it('refuses to touch a batch another tick is already draining', async () => {
    // The browser drives ticks while the scheduler also fires them, so two can
    // overlap; without the lease they would trash the same files twice.
    await queue(70);
    trashDriveFile.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 30));
      return { ok: true, status: 200 };
    });
    const inFlight = drainDuplicateRemovalQueue();
    await new Promise((r) => setTimeout(r, 20)); // let it claim the lease
    const overlapping = await drainDuplicateRemovalQueue();
    expect(overlapping.busy).toBe(true);
    expect(overlapping.processed).toBe(0);

    const first = await inFlight;
    expect(first.busy).toBeUndefined();
    // Only the lease holder did work.
    expect(first.processed).toBe(trashDriveFile.mock.calls.length);
  });

  it('trashes nothing when there is no Sheet to ledger into', async () => {
    const id = await queue(3);
    env.MASTER_SPREADSHEET_ID = '';
    const out = await drainDuplicateRemovalQueue();
    expect(out.processed).toBe(0);
    expect(trashDriveFile).not.toHaveBeenCalled();
    const batch = await getDuplicateBatch(id);
    expect(batch!.pending).toHaveLength(3);
    expect(batch!.warnings.join(' ')).toContain('MASTER_SPREADSHEET_ID');
  });

  it('skips the sweep entirely when managed folders are off', async () => {
    const id = await queue(2);
    env.MANAGED_FOLDERS_ENABLED = 'false';
    const out = await drainDuplicateRemovalQueue();
    expect(out.finished).toBe(true);
    expect(removeShortcutsForTargets).not.toHaveBeenCalled();
    expect(tryRebuildPublicFolderIndex).not.toHaveBeenCalled();
    expect((await getDuplicateBatch(id))!.pendingSweep).toEqual([]);
  });

  it('gives up on a batch whose every trash fails instead of burning the tick', async () => {
    const id = await queue(30);
    trashDriveFile.mockResolvedValue({ ok: false, error: 'HTTP 403', status: 403 });
    const out = await drainDuplicateRemovalQueue();
    expect(out.processed).toBe(0);
    expect(out.failed).toBe(10);
    // Stopped after the first all-failed chunk, not after all 30.
    expect(trashDriveFile).toHaveBeenCalledTimes(10);
    expect((await getDuplicateBatch(id))!.pending).toHaveLength(20);
  });
});
