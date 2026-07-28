/**
 * eventDeletionService — the ordering and safety rules that make an event delete
 * survivable:
 *
 *   1. A dry run writes NOTHING.
 *   2. Links are revoked before anything else (no uploads into a dying event).
 *   3. The Sheet row goes BEFORE the Firestore docs — the reconciler is additive,
 *      so the other order lets the next sync tick recreate the event.
 *   4. A derivatives sweep that runs out of budget leaves the Sheet row and the
 *      Firestore docs alone, so re-running finishes the job.
 *   5. Staged uploads are counted, never deleted.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.MASTER_SPREADSHEET_ID = 'sheet1';

/** Ordered log of every mutating call, so we can assert the sequence. */
const calls: string[] = [];

let sheetEvent: Record<string, string> | null = null;
let cachedEvent: Record<string, unknown> | null = null;
let links: Array<{ linkId: string; status: string }> = [];
let specialRows: Array<{ folderId: string; eventId: string }> = [];
let driveFolder: { id: string; name: string } | null = null;
let derivatives = { count: 0, capped: false };
let staged = { count: 0, capped: false };
let sweep: { deleted: number; remaining: boolean } = { deleted: 0, remaining: false };
let scopedDocs: Record<string, number> = {};

const deleteEventRow = vi.fn(async (_sid: string, id: string) => {
  calls.push(`sheetRow:${id}`);
  return sheetEvent ? 1 : 0;
});
vi.mock('../src/services/eventStore.js', () => ({
  findById: async (_sid: string, id: string) => (sheetEvent && sheetEvent.eventId === id ? sheetEvent : null),
  deleteEventRow: (...a: unknown[]) => deleteEventRow(...(a as [string, string])),
}));

vi.mock('../src/services/linkStore.js', () => ({
  listLinks: async () => links,
  revokeLink: async (_sid: string, linkId: string) => {
    calls.push(`revoke:${linkId}`);
    return { linkId, status: 'inactive' };
  },
}));

const trashFile = vi.fn(async (id: string) => {
  calls.push(`trash:${id}`);
});
vi.mock('../src/services/driveService.js', () => ({
  getFolderById: async () => driveFolder,
  trashFile: (...a: unknown[]) => trashFile(...(a as [string])),
}));

vi.mock('../src/services/deletedFilesStore.js', () => ({
  recordSoftDelete: async () => {
    calls.push('ledger');
    return { deleteId: 'del-1' };
  },
}));

vi.mock('../src/services/gcsService.js', () => ({
  countEventDerivatives: async () => derivatives,
  countStagedObjectsForEvent: async () => staged,
  deleteEventDerivatives: async () => {
    calls.push('sweep');
    return sweep;
  },
}));

vi.mock('../src/services/specialFoldersStore.js', () => ({
  listAllSpecialFolders: async () => specialRows,
  deleteSpecialFolderRowsByFolderId: async (_sid: string, ids: ReadonlySet<string>) => {
    calls.push(`specialRows:${ids.size}`);
    return ids.size;
  },
}));

const tryRebuildPublicFolderIndex = vi.fn(async () => undefined);
vi.mock('../src/services/publicFolderIndexService.js', () => ({
  tryRebuildPublicFolderIndex: () => tryRebuildPublicFolderIndex(),
}));

/**
 * Minimal Firestore double: `scopedDocs` is the live per-collection doc count, so
 * a counting query reads it non-destructively and a batch delete actually drains
 * it — which is what lets us assert that the inventory count and the delete count
 * agree instead of the count silently consuming the docs.
 */
vi.mock('../src/lib/firestore.js', () => {
  const batch = () => {
    const ops: Array<() => void> = [];
    return {
      delete: (ref: { path: string }) =>
        ops.push(() => {
          calls.push(`fsDelete:${ref.path}`);
          const c = ref.path.split('/')[0] ?? '';
          scopedDocs[c] = Math.max(0, (scopedDocs[c] ?? 0) - 1);
        }),
      commit: async () => ops.forEach((op) => op()),
    };
  };
  const collection = (name: string) => {
    const query = {
      where: () => query,
      limit: () => query,
      select: () => query,
      get: async () => {
        const n = scopedDocs[name] ?? 0;
        return {
          size: n,
          empty: n === 0,
          docs: Array.from({ length: n }, (_, i) => ({ ref: { path: `${name}/${i}` } })),
        };
      },
    };
    return {
      ...query,
      doc: (id: string) => ({
        get: async () => ({ exists: cachedEvent !== null, data: () => cachedEvent }),
        delete: async () => {
          calls.push(`fsDoc:${name}/${id}`);
        },
      }),
    };
  };
  return { firestore: () => ({ collection, batch }) };
});

const { deleteEvent, previewEventDeletion, resolveEvent } = await import('../src/services/eventDeletionService.js');

const SID = 'sheet1';
const EVENT = {
  eventId: 'ev1',
  name: 'Test',
  date: '2026-05-01',
  folderName: '2026-05-01_Test',
  driveFolderId: 'folder-1',
  createdBy: 'a@x.org',
  createdAt: 't',
};

beforeEach(() => {
  calls.length = 0;
  sheetEvent = { ...EVENT };
  cachedEvent = { name: 'Test', date: '2026-05-01', driveFolderId: 'folder-1' };
  links = [
    { linkId: 'l1', status: 'active' },
    { linkId: 'l2', status: 'inactive' },
  ];
  specialRows = [{ folderId: 'mf1', eventId: 'ev1' }];
  driveFolder = { id: 'folder-1', name: '2026-05-01_Test' };
  derivatives = { count: 12, capped: false };
  staged = { count: 0, capped: false };
  sweep = { deleted: 12, remaining: false };
  scopedDocs = { photos: 3, uploadLinks: 1 };
  tryRebuildPublicFolderIndex.mockClear();
  deleteEventRow.mockClear();
  trashFile.mockClear();
});

describe('resolveEvent', () => {
  it('merges the Sheet row with the cache, Sheet winning', async () => {
    cachedEvent = { name: 'Stale name', driveFolderId: 'stale' };
    const ev = await resolveEvent(SID, 'ev1');
    expect(ev).toMatchObject({ name: 'Test', driveFolderId: 'folder-1', inSheet: true, inFirestore: true });
  });

  it('resolves a Firestore-only orphan so it can still be deleted', async () => {
    sheetEvent = null;
    const ev = await resolveEvent(SID, 'ev1');
    expect(ev).toMatchObject({ name: 'Test', inSheet: false, inFirestore: true });
  });

  it('returns null when neither store knows the event', async () => {
    sheetEvent = null;
    cachedEvent = null;
    expect(await resolveEvent(SID, 'ev1')).toBeNull();
  });
});

describe('previewEventDeletion', () => {
  it('counts everything and writes nothing', async () => {
    derivatives = { count: 40, capped: false };
    const out = await previewEventDeletion(SID, 'ev1');
    expect(out.ok).toBe(true);
    expect(out.data?.apply).toBe(false);
    expect(out.data?.inventory).toMatchObject({
      photos: 3,
      links: 2,
      activeLinks: 1,
      specialFolderRows: 1,
      derivativeObjects: 40,
      driveFolderExists: true,
      sheetRowExists: true,
    });
    expect(calls).toEqual([]);
  });

  it('warns about staged uploads and does not plan to delete them', async () => {
    staged = { count: 7, capped: false };
    const out = await previewEventDeletion(SID, 'ev1');
    expect(out.data?.inventory.stagedObjects).toBe(7);
    expect(out.data?.warnings.join(' ')).toContain('NOT deleted');
    expect(calls).toEqual([]);
  });

  it('404s for an unknown event', async () => {
    sheetEvent = null;
    cachedEvent = null;
    const out = await previewEventDeletion(SID, 'ev1');
    expect(out.ok).toBe(false);
    expect(out.data).toBeUndefined();
  });
});

describe('deleteEvent', () => {
  it('revokes links, trashes + ledgers Drive, then Sheet row, then Firestore', async () => {
    const out = await deleteEvent(SID, 'ev1', { actorEmail: 'boss@x.org' });
    expect(out.ok).toBe(true);
    expect(out.data?.apply).toBe(true);
    expect(out.data?.driveFolderTrashed).toBe(true);
    expect(out.data?.deleteId).toBe('del-1');
    expect(out.data?.removed).toMatchObject({
      linksRevoked: 1, // only the active one
      sheetRowsRemoved: 1,
      specialFolderRows: 1,
      derivativeObjects: 12,
    });

    // Order is the contract: revoke → trash → ledger → sweep → Sheet → Firestore.
    const order = calls.filter((c) => !c.startsWith('fsDelete:'));
    expect(order.slice(0, 5)).toEqual(['revoke:l1', 'trash:folder-1', 'ledger', 'specialRows:1', 'sweep']);
    expect(order.indexOf('sheetRow:ev1')).toBeLessThan(order.indexOf('fsDoc:events/ev1'));
    expect(order.indexOf('sheetRow:ev1')).toBeGreaterThan(order.indexOf('sweep'));
    // Photo/link docs plus the events doc itself.
    expect(out.data?.removed.firestoreDocs).toBe(3 + 1 + 1);
    expect(tryRebuildPublicFolderIndex).toHaveBeenCalledTimes(1);
  });

  it('stops before the Sheet row when the derivatives sweep runs out of budget', async () => {
    sweep = { deleted: 5, remaining: true };
    const out = await deleteEvent(SID, 'ev1', { actorEmail: 'boss@x.org' });
    expect(out.data?.derivativesRemaining).toBe(true);
    expect(out.data?.message).toContain('again');
    expect(calls).toContain('sweep');
    expect(calls.some((c) => c.startsWith('sheetRow:'))).toBe(false);
    expect(calls.some((c) => c.startsWith('fsDoc:'))).toBe(false);
    expect(out.data?.removed.sheetRowsRemoved).toBe(0);
  });

  it('leaves the Firestore docs when the Sheet row cannot be deleted', async () => {
    deleteEventRow.mockRejectedValueOnce(new Error('Sheets 500'));
    const out = await deleteEvent(SID, 'ev1', { actorEmail: 'boss@x.org' });
    expect(out.ok).toBe(true);
    expect(out.data?.removed.sheetRowsRemoved).toBe(0);
    expect(calls.some((c) => c.startsWith('fsDoc:'))).toBe(false);
    expect(out.data?.warnings.join(' ')).toContain('reconciler');
  });

  it('skips the trash when the Drive folder is already gone, and still finishes', async () => {
    driveFolder = null;
    const out = await deleteEvent(SID, 'ev1', { actorEmail: 'boss@x.org' });
    expect(calls.some((c) => c.startsWith('trash:'))).toBe(false);
    expect(out.data?.driveFolderTrashed).toBe(false);
    expect(out.data?.removed.sheetRowsRemoved).toBe(1);
    expect(out.data?.warnings.join(' ')).toContain('already missing');
  });

  it('keeps going when the Drive trash fails, and does not ledger a delete that did not happen', async () => {
    trashFile.mockRejectedValueOnce(new Error('Drive trash 500'));
    const out = await deleteEvent(SID, 'ev1', { actorEmail: 'boss@x.org' });
    expect(out.data?.driveFolderTrashed).toBe(false);
    expect(out.data?.deleteId).toBe('');
    expect(calls).not.toContain('ledger');
    expect(out.data?.warnings.join(' ')).toContain('Could not trash');
  });

  it('404s for an unknown event without writing', async () => {
    sheetEvent = null;
    cachedEvent = null;
    const out = await deleteEvent(SID, 'ev1', { actorEmail: 'boss@x.org' });
    expect(out.ok).toBe(false);
    expect(calls).toEqual([]);
  });
});
