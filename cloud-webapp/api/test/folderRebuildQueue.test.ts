import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Unit test for the managed-folder rebuild queue (folderRebuildQueue.ts):
 * enqueue → drain (claim/rebuild each event) → done + one public-index refresh,
 * including a per-event failure. Firestore, the Drive-heavy rebuild fns, and the
 * public-index refresh are faked with an in-memory store.
 */

const state = vi.hoisted(() => {
  return {
    docs: new Map<string, Record<string, unknown>>(),
    seq: 0,
    rebuilt: [] as string[],
    failOn: new Set<string>(),
    publicRefreshed: 0,
    clone: <T>(o: T): T => JSON.parse(JSON.stringify(o)) as T,
    applyUpdate(cur: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
      const out: Record<string, unknown> = { ...cur };
      for (const [k, v] of Object.entries(patch)) {
        if (v && typeof v === 'object' && '__arrayUnion' in (v as Record<string, unknown>)) {
          const arr = Array.isArray(out[k]) ? [...(out[k] as unknown[])] : [];
          for (const item of (v as { __arrayUnion: unknown[] }).__arrayUnion) arr.push(item);
          out[k] = arr;
        } else {
          out[k] = v;
        }
      }
      return out;
    },
  };
});

vi.mock('@google-cloud/firestore', () => ({
  FieldValue: { arrayUnion: (...vals: unknown[]) => ({ __arrayUnion: vals }) },
}));

vi.mock('../src/lib/logger.js', () => ({
  logger: { info() {}, warn() {}, error() {}, debug() {} },
}));

vi.mock('../src/services/specialFoldersService.js', () => ({
  rebuildEventPhotoFolders: async (id: string) => {
    if (state.failOn.has(`photos:${id}`)) return { ok: false, message: `photos boom ${id}` };
    state.rebuilt.push(`photos:${id}`);
    return {
      ok: true,
      message: '',
      data: { targetFilesScanned: 1200, foldersTouched: 3, shortcutsCreated: 0, shortcutsExisting: 1200, warnings: [] },
    };
  },
  countEventMedia: async (_id: string) => ({ photos: 339, videos: 5, media: 344 }),
  rebuildEventVideoFolders: async (id: string) => {
    state.rebuilt.push(`videos:${id}`);
    return { ok: true, scopesProcessed: 2, foldersTouched: 2, shortcutsCreated: 5, shortcutsExisting: 0, filesScanned: 5, warnings: [] };
  },
  rebuildEventAlbumFolders: async (id: string) => {
    if (state.failOn.has(`albums:${id}`)) throw new Error(`albums boom ${id}`);
    state.rebuilt.push(`albums:${id}`);
    return { ok: true, scopesProcessed: 2, foldersTouched: 2, shortcutsCreated: 9, shortcutsExisting: 0, filesScanned: 9, warnings: [] };
  },
  rebuildAllSpecialFoldersForEvent: async (id: string) => {
    if (state.failOn.has(id)) throw new Error(`boom ${id}`);
    state.rebuilt.push(id);
    return { photos: { ok: true, message: '' }, scopes: [] };
  },
  migrateEventPhotoShortcutsToFiles: async (id: string) => {
    state.rebuilt.push(id);
    return { ok: true, message: '' };
  },
}));

vi.mock('../src/services/publicFolderIndexService.js', () => ({
  rebuildPublicFolderIndex: async () => {
    state.publicRefreshed++;
    return 0;
  },
}));

vi.mock('../src/lib/firestore.js', () => {
  const snap = (id: string) => {
    const data = state.docs.get(id);
    return {
      exists: data !== undefined,
      id,
      data: () => (data ? state.clone(data) : undefined),
      get: (field: string) => (data ? state.clone(data)[field] : undefined),
    };
  };
  const ref = (id: string) => ({
    id,
    set: async (d: Record<string, unknown>) => {
      state.docs.set(id, state.clone(d));
    },
    update: async (patch: Record<string, unknown>) => {
      state.docs.set(id, state.applyUpdate(state.docs.get(id) ?? {}, patch));
    },
    get: async () => snap(id),
  });
  const runningAsc = () =>
    [...state.docs.entries()]
      .filter(([, d]) => d.status === 'running')
      .sort((a, b) => String(a[1].createdAt).localeCompare(String(b[1].createdAt)));
  const allDesc = () =>
    [...state.docs.entries()].sort((a, b) => String(b[1].createdAt).localeCompare(String(a[1].createdAt)));
  const wrap = (entry?: [string, Record<string, unknown>]) => ({
    docs: entry ? [{ id: entry[0], data: () => state.clone(entry[1]) }] : [],
  });
  const collection = () => ({
    doc: (id?: string) => ref(id ?? `b${++state.seq}`),
    where: () => ({
      orderBy: () => ({ limit: () => ({ get: async () => wrap(runningAsc()[0]) }) }),
    }),
    orderBy: () => ({ limit: () => ({ get: async () => wrap(allDesc()[0]) }) }),
  });
  const db = {
    collection: () => collection(),
    runTransaction: async (fn: (tx: unknown) => unknown) =>
      fn({
        get: async (r: { id: string }) => snap(r.id),
        update: (r: { id: string }, patch: Record<string, unknown>) => {
          state.docs.set(r.id, state.applyUpdate(state.docs.get(r.id) ?? {}, patch));
        },
      }),
  };
  return { firestore: () => db };
});

const q = await import('../src/services/folderRebuildQueue.js');

describe('folderRebuildQueue', () => {
  beforeEach(() => {
    state.docs.clear();
    state.seq = 0;
    state.rebuilt.length = 0;
    state.failOn.clear();
    state.publicRefreshed = 0;
  });

  it('drains an all-events batch to done and refreshes the public index once', async () => {
    const { id, total } = await q.enqueueRebuild('videos-albums', ['e1', 'e2', 'e3'], {
      createdBy: 'admin@x',
      refreshPublic: true,
    });
    expect(total).toBe(3);

    const summary = await q.drainRebuildQueue(60_000);
    expect(summary.drained).toBe(true);
    expect(summary.processed).toBe(3);
    expect(summary.failed).toBe(0);
    expect(summary.finished).toBe(true);
    expect(summary.remaining).toBe(0);

    const batch = await q.getBatch(id);
    expect(batch?.status).toBe('done');
    expect([...(batch?.done ?? [])].sort()).toEqual(['e1', 'e2', 'e3']);
    expect(state.rebuilt.sort()).toEqual(['e1', 'e2', 'e3']);
    expect(state.publicRefreshed).toBe(1);
  });

  it('records per-event failures but still finishes the batch', async () => {
    state.failOn.add('e2');
    const { id } = await q.enqueueRebuild('videos-albums', ['e1', 'e2', 'e3'], { createdBy: 'admin@x' });

    const summary = await q.drainRebuildQueue(60_000);
    expect(summary.finished).toBe(true);
    expect(summary.failed).toBe(1);

    const batch = await q.getBatch(id);
    expect(batch?.status).toBe('done');
    expect(batch?.done.sort()).toEqual(['e1', 'e3']);
    expect(batch?.failed).toEqual([{ eventId: 'e2', error: 'boom e2' }]);
  });

  it('is a no-op when nothing is queued', async () => {
    const summary = await q.drainRebuildQueue(60_000);
    expect(summary).toEqual({ drained: false, processed: 0, failed: 0, remaining: 0, finished: false });
  });

  it('drains a single-event full batch through its 5 steps with counts', async () => {
    const { id, total } = await q.enqueueFullRebuild('e1', { createdBy: 'admin@x' });
    expect(total).toBe(1);

    const summary = await q.drainRebuildQueue(60_000);
    expect(summary.drained).toBe(true);
    expect(summary.processed).toBe(5);
    expect(summary.failed).toBe(0);
    expect(summary.finished).toBe(true);
    expect(summary.remaining).toBe(0);

    const batch = await q.getBatch(id);
    expect(batch?.kind).toBe('full');
    expect(batch?.status).toBe('done');
    const steps = batch?.steps ?? [];
    expect(steps.map((s) => s.key)).toEqual(['count', 'photos', 'videos', 'albums', 'public']);
    expect(steps.every((s) => s.status === 'done')).toBe(true);
    // The count step surfaces the media totals first.
    const count = steps.find((s) => s.key === 'count');
    expect(count?.total).toBe(344);
    expect(count?.note).toContain('339 photo');
    // It seeds the videos denominator (5) before the videos step overwrites it
    // with its own scope-based count once it runs.
    expect(steps.find((s) => s.key === 'photos')?.total).toBe(1200);
    expect(steps.find((s) => s.key === 'videos')?.done).toBe(2);
    expect(state.rebuilt).toEqual(['photos:e1', 'videos:e1', 'albums:e1']);
    // The public step runs the index refresh exactly once.
    expect(state.publicRefreshed).toBe(1);
  });

  it('marks a failed step but still finishes the full batch', async () => {
    state.failOn.add('albums:e1');
    const { id } = await q.enqueueFullRebuild('e1', { createdBy: 'admin@x' });

    const summary = await q.drainRebuildQueue(60_000);
    expect(summary.finished).toBe(true);
    expect(summary.failed).toBe(1);

    const batch = await q.getBatch(id);
    expect(batch?.status).toBe('done');
    const steps = batch?.steps ?? [];
    const albums = steps.find((s) => s.key === 'albums');
    expect(albums?.status).toBe('failed');
    expect(albums?.error).toContain('albums boom e1');
    // Photos / videos / public still completed despite the album failure.
    expect(steps.find((s) => s.key === 'public')?.status).toBe('done');
  });
});
