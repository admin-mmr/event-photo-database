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
    state.rebuilt.push(id);
    return { ok: true, message: '' };
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
});
