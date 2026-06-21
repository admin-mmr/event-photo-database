import { describe, it, expect, vi, beforeEach } from 'vitest';

// Fake Firestore supporting collection().where().get(), batch().delete()/commit(),
// and collection().add() — enough to exercise the delete cascade.
const h = vi.hoisted(() => {
  const store: Record<string, Map<string, Record<string, unknown>>> = {};
  return {
    store,
    reset(): void {
      for (const k of Object.keys(store)) delete store[k];
    },
    seed(coll: string, id: string, data: Record<string, unknown>): void {
      (store[coll] ??= new Map()).set(id, data);
    },
    api: {
      collection(name: string) {
        const coll = (store[name] ??= new Map());
        return {
          where(field: string, _op: string, val: unknown) {
            return {
              async get() {
                const docs = [...coll.entries()]
                  .filter(([, d]) => d[field] === val)
                  .map(([id, d]) => ({ id, data: () => d, ref: { c: name, id } }));
                return { docs };
              },
            };
          },
          async add(data: Record<string, unknown>) {
            const id = `${name}-add-${coll.size}`;
            coll.set(id, data);
            return { id };
          },
        };
      },
      batch() {
        const ops: Array<() => void> = [];
        return {
          delete(ref: { c: string; id: string }) {
            ops.push(() => store[ref.c]?.delete(ref.id));
          },
          async commit() {
            ops.forEach((o) => o());
          },
        };
      },
    },
  };
});

vi.mock('../src/lib/firestore.js', () => ({ firestore: () => h.api }));

const deleteReferenceObject = vi.fn();
vi.mock('../src/services/gcsService.js', () => ({
  deleteReferenceObject: (...a: unknown[]) => deleteReferenceObject(...(a as [])),
}));

const { deleteAllUserData } = await import('../src/services/userData.js');

beforeEach(() => {
  h.reset();
  deleteReferenceObject.mockReset();
  deleteReferenceObject.mockResolvedValue(undefined);
});

describe('deleteAllUserData (M5.2 cascade)', () => {
  it('purges the user across all collections and deletes their GCS objects', async () => {
    h.seed('find_me_uploads', 'up-1', { uid: 'u1', gcsPath: 'find_me_references/u1/up-1.jpg' });
    h.seed('find_me_uploads', 'up-2', { uid: 'u1', gcsPath: 'find_me_references/u1/up-2.jpg' });
    h.seed('find_me_uploads', 'up-x', { uid: 'u2', gcsPath: 'find_me_references/u2/up-x.jpg' });
    h.seed('consents', 'c1', { uid: 'u1', action: 'findme_search' });
    h.seed('consents', 'c2', { uid: 'u1', action: 'findme_search' });
    h.seed('consents', 'cx', { uid: 'u2', action: 'findme_search' });
    h.seed('match_runs', 'r1', { uid: 'u1' });
    h.seed('match_feedback', 'f1', { uid: 'u1' });
    h.seed('match_feedback', 'f2', { uid: 'u1' });
    h.seed('match_feedback', 'f3', { uid: 'u1' });

    const counts = await deleteAllUserData('u1', 'm@x');

    expect(counts).toEqual({ references: 2, consents: 2, matchRuns: 1, feedback: 3 });

    // Both of u1's reference objects were deleted from GCS.
    expect(deleteReferenceObject).toHaveBeenCalledTimes(2);
    expect(deleteReferenceObject).toHaveBeenCalledWith('find_me_references/u1/up-1.jpg');
    expect(deleteReferenceObject).toHaveBeenCalledWith('find_me_references/u1/up-2.jpg');

    // u1's records are gone; u2's are untouched.
    expect(h.store.find_me_uploads?.has('up-1')).toBe(false);
    expect(h.store.find_me_uploads?.has('up-x')).toBe(true);
    expect(h.store.match_runs?.size).toBe(0);
    expect(h.store.match_feedback?.size).toBe(0);

    // The two original consents are deleted, but a single data_deleted audit
    // record remains (written after the purge).
    const consents = [...(h.store.consents?.values() ?? [])];
    expect(consents).toHaveLength(2); // cx (u2) + the new audit doc
    const audit = consents.find((c) => c.action === 'data_deleted');
    expect(audit).toBeTruthy();
    expect(audit).toMatchObject({ uid: 'u1', email: 'm@x' });
    expect(audit?.deletedCounts).toEqual(counts);
  });

  it('continues the Firestore purge even if a GCS object delete fails', async () => {
    h.seed('find_me_uploads', 'up-1', { uid: 'u1', gcsPath: 'p1' });
    deleteReferenceObject.mockRejectedValueOnce(new Error('boom'));
    const counts = await deleteAllUserData('u1', null);
    expect(counts.references).toBe(1);
    expect(h.store.find_me_uploads?.has('up-1')).toBe(false);
  });

  it('is a no-op (zero counts) for a user with no data', async () => {
    const counts = await deleteAllUserData('ghost', null);
    expect(counts).toEqual({ references: 0, consents: 0, matchRuns: 0, feedback: 0 });
    expect(deleteReferenceObject).not.toHaveBeenCalled();
  });
});
