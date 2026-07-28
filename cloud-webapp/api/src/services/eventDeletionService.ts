/**
 * eventDeletionService.ts — remove an event and everything that hangs off it.
 *
 * An event is spread across five stores, and until this existed the only way to
 * retire one (a test event, a duplicate, a mistake) was to hand-edit all five in
 * the right order. The layers, and what happens to each:
 *
 *   1. Upload links  (Sheet `Upload_Links`)  → REVOKED, rows kept for the audit
 *                                              trail. Revoking first means no
 *                                              volunteer can upload into an event
 *                                              that is being deleted.
 *   2. Drive folder                          → TRASHED (recoverable ~30 days) and
 *                                              ledgered in `Deleted_Files`, so the
 *                                              existing restore/purge lifecycle
 *                                              (G5.1) owns it from here. The
 *                                              managed folders (Photos_NNN /
 *                                              Videos / Album) live inside the
 *                                              event folder, so they go with it.
 *   3. Derivatives bucket `<eventId>/`       → DELETED. Regenerable by a re-index.
 *   4. Sheet `Events` row                    → DELETED (see `deleteEventRow`: the
 *                                              Sheet is SSOT, so this must happen
 *                                              or the reconciler resurrects the
 *                                              event on its next tick).
 *   5. Firestore caches                      → DELETED (`events`, `photos`,
 *                                              `uploadLinks`, `upload_batches`,
 *                                              `upload_dedup`, `match_runs`,
 *                                              `match_feedback`, `specialFolders`).
 *
 * NOT touched: staged volunteer uploads. A staged object can be the only copy of
 * a photo that never reached Drive, and deleting those is exactly what destroyed
 * volunteer photos on 2026-07-27/28. They are counted and reported; the staging
 * bucket's lifecycle rule reclaims them.
 *
 * Two invariants worth keeping if you touch this:
 *
 *   • DRY RUN unless the caller passes `apply: true` (truthy-but-not-`true` must
 *     not write), matching the resync-names / duplicate-removal convention.
 *   • THE SLOW WORK COMES BEFORE THE IDENTITY RECORDS. The derivatives sweep is
 *     the only unbounded step, so it runs while the event is still resolvable and
 *     the Sheet row + Firestore docs are deleted only after it finishes. A sweep
 *     cut short by the request budget returns `derivativesRemaining: true` with
 *     the event still listed, and re-running the same call finishes it — every
 *     step here is idempotent. (Do NOT "fix" this by deleting the row first: the
 *     leftover objects would then have no owner and nothing would ever sweep them.)
 */

import type {
  DeleteEventRemoved,
  DeleteEventResponse,
  EventInventory,
} from '@cloud-webapp/shared';

import { firestore } from '../lib/firestore.js';
import { logger } from '../lib/logger.js';
import { UserStatus } from '../lib/roles.js';
import { recordSoftDelete } from './deletedFilesStore.js';
import { getFolderById, trashFile } from './driveService.js';
import { deleteEventRow, findById } from './eventStore.js';
import {
  countEventDerivatives,
  countStagedObjectsForEvent,
  deleteEventDerivatives,
} from './gcsService.js';
import { listLinks, revokeLink } from './linkStore.js';
import { tryRebuildPublicFolderIndex } from './publicFolderIndexService.js';
import { deleteSpecialFolderRowsByFolderId, listAllSpecialFolders } from './specialFoldersStore.js';

/** Firestore collections holding per-event docs, keyed by an `eventId` field. */
const EVENT_SCOPED_COLLECTIONS = [
  'photos',
  'uploadLinks',
  'upload_batches',
  'upload_dedup',
  'match_runs',
  'match_feedback',
] as const;

/** Firestore caps a batch at 500 writes; stay under it. */
const BATCH_LIMIT = 400;

/**
 * Wall-clock left for the derivatives sweep. Firebase Hosting kills a
 * browser-routed request at 60s no matter what Cloud Run's timeout says, so the
 * sweep gets a slice of that and reports what it couldn't finish.
 */
const DERIVATIVES_BUDGET_MS = 25_000;

export interface EventIdentity {
  eventId: string;
  name: string;
  date: string;
  folderName: string;
  driveFolderId: string;
  /** The event has a row in the Sheet's Events tab (the SSOT). */
  inSheet: boolean;
  /** The event has a doc in the Firestore `events` cache. */
  inFirestore: boolean;
}

export interface ServiceResult<T> {
  ok: boolean;
  message: string;
  data?: T;
}

/**
 * Resolve an event from BOTH stores and merge them, because a half-deleted event
 * (or a Firestore-only orphan the reconciler has reported) must still be
 * deletable. The Sheet wins on any field it has, being SSOT.
 */
export async function resolveEvent(spreadsheetId: string, eventId: string): Promise<EventIdentity | null> {
  // A failing Sheet read propagates (500): the Sheet is SSOT, and a delete that
  // can't see it would leave the row behind for the reconciler to resurrect. A
  // failing cache read is survivable — the Sheet row alone is enough to proceed.
  const [sheetRow, doc] = await Promise.all([
    findById(spreadsheetId, eventId),
    firestore()
      .collection('events')
      .doc(eventId)
      .get()
      .catch((err: unknown) => {
        logger.warn({ err, eventId }, 'event delete: Firestore lookup failed (treating as absent)');
        return null;
      }),
  ]);

  const cached = doc?.exists ? (doc.data() ?? {}) : null;
  if (!sheetRow && !cached) return null;

  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  return {
    eventId,
    name: sheetRow?.name || str(cached?.name),
    date: sheetRow?.date || str(cached?.date),
    folderName: sheetRow?.folderName || str(cached?.folderName),
    driveFolderId: sheetRow?.driveFolderId || str(cached?.driveFolderId),
    inSheet: Boolean(sheetRow),
    inFirestore: Boolean(cached),
  };
}

/** Count docs in one collection for this event (ids only — no document reads). */
async function countScoped(collection: string, eventId: string): Promise<number> {
  try {
    const snap = await firestore().collection(collection).where('eventId', '==', eventId).select().get();
    return snap.size;
  } catch (err) {
    logger.warn({ err, collection, eventId }, 'event delete: count failed (reported as 0)');
    return 0;
  }
}

/** Delete every doc in one collection for this event, in batches. Returns the count. */
async function deleteScoped(collection: string, eventId: string): Promise<number> {
  const db = firestore();
  let total = 0;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const snap = await db
      .collection(collection)
      .where('eventId', '==', eventId)
      .limit(BATCH_LIMIT)
      .select()
      .get();
    if (snap.empty) return total;
    const batch = db.batch();
    for (const d of snap.docs) batch.delete(d.ref);
    // eslint-disable-next-line no-await-in-loop
    await batch.commit();
    total += snap.size;
    if (snap.size < BATCH_LIMIT) return total;
  }
}

/**
 * Count everything the event owns, touching nothing. Drives both the dry run and
 * the "are you sure" numbers in the admin UI.
 */
export async function inventoryEvent(
  spreadsheetId: string,
  event: EventIdentity,
): Promise<EventInventory> {
  const [
    counts,
    links,
    specialFolders,
    derivatives,
    staged,
    driveFolder,
  ] = await Promise.all([
    Promise.all(EVENT_SCOPED_COLLECTIONS.map((c) => countScoped(c, event.eventId))),
    listLinks(spreadsheetId, { eventId: event.eventId }).catch((err: unknown) => {
      logger.warn({ err, eventId: event.eventId }, 'event delete: link listing failed');
      return [];
    }),
    listAllSpecialFolders(spreadsheetId).catch((err: unknown) => {
      logger.warn({ err, eventId: event.eventId }, 'event delete: Special_Folders listing failed');
      return [];
    }),
    countEventDerivatives(event.eventId).catch((err: unknown) => {
      logger.warn({ err, eventId: event.eventId }, 'event delete: derivatives count failed');
      return { count: 0, capped: false };
    }),
    countStagedObjectsForEvent(event.eventId).catch((err: unknown) => {
      logger.warn({ err, eventId: event.eventId }, 'event delete: staging count failed');
      return { count: 0, capped: false };
    }),
    event.driveFolderId
      ? getFolderById(event.driveFolderId).catch((err: unknown) => {
          logger.warn({ err, eventId: event.eventId }, 'event delete: Drive folder lookup failed');
          return null;
        })
      : Promise.resolve(null),
  ]);

  const byCollection = new Map(EVENT_SCOPED_COLLECTIONS.map((c, i) => [c, counts[i] ?? 0]));
  return {
    photos: byCollection.get('photos') ?? 0,
    links: links.length,
    activeLinks: links.filter((l) => l.status === UserStatus.ACTIVE).length,
    uploadBatches: byCollection.get('upload_batches') ?? 0,
    dedupClaims: byCollection.get('upload_dedup') ?? 0,
    matchRuns: byCollection.get('match_runs') ?? 0,
    matchFeedback: byCollection.get('match_feedback') ?? 0,
    specialFolderRows: specialFolders.filter((r) => r.eventId === event.eventId).length,
    derivativeObjects: derivatives.count,
    derivativeObjectsCapped: derivatives.capped,
    stagedObjects: staged.count,
    driveFolderExists: Boolean(driveFolder),
    sheetRowExists: event.inSheet,
  };
}

const ZERO_REMOVED: DeleteEventRemoved = {
  linksRevoked: 0,
  sheetRowsRemoved: 0,
  specialFolderRows: 0,
  firestoreDocs: 0,
  derivativeObjects: 0,
};

function baseResponse(event: EventIdentity, inventory: EventInventory): DeleteEventResponse {
  return {
    ok: true,
    apply: false,
    eventId: event.eventId,
    eventName: event.name,
    eventDate: event.date,
    folderName: event.folderName,
    driveFolderId: event.driveFolderId,
    message: '',
    inventory,
    removed: { ...ZERO_REMOVED },
    driveFolderTrashed: false,
    deleteId: '',
    derivativesRemaining: false,
    warnings: [],
  };
}

/** Warnings worth showing before an admin confirms — the "this is a real event" tells. */
function inventoryWarnings(inventory: EventInventory): string[] {
  const out: string[] = [];
  if (inventory.photos > 0) {
    out.push(
      `${inventory.photos} indexed photo(s) will disappear from the gallery; the Drive files go to trash (restorable).`,
    );
  }
  if (inventory.stagedObjects > 0) {
    out.push(
      `${inventory.stagedObjects} staged upload(s) are NOT deleted — they may be the only copy of photos never copied to Drive. ` +
        'Run recover-staged-uploads.sh first if you want them, or let the staging bucket lifecycle expire them.',
    );
  }
  if (inventory.matchFeedback > 0) {
    out.push(`${inventory.matchFeedback} Find Me feedback label(s) will be deleted (they are eval data).`);
  }
  if (!inventory.driveFolderExists) {
    out.push('The Drive folder is already missing or trashed — nothing to trash.');
  }
  return out;
}

/** A dry run: inventory + the warnings, and not a single write. */
export async function previewEventDeletion(
  spreadsheetId: string,
  eventId: string,
): Promise<ServiceResult<DeleteEventResponse>> {
  const event = await resolveEvent(spreadsheetId, eventId);
  if (!event) return { ok: false, message: `Event "${eventId}" not found in the Sheet or the events cache` };

  const inventory = await inventoryEvent(spreadsheetId, event);
  const body = baseResponse(event, inventory);
  body.warnings = inventoryWarnings(inventory);
  body.message =
    `Dry run — nothing was changed. Deleting "${event.name || eventId}" would revoke ${inventory.activeLinks} ` +
    `active link(s), trash the Drive folder, and drop ${inventory.photos} photo(s) plus ` +
    `${inventory.derivativeObjects}${inventory.derivativeObjectsCapped ? '+' : ''} derivative object(s).`;
  return { ok: true, message: body.message, data: body };
}

export interface DeleteEventOptions {
  actorEmail: string;
  reason?: string | undefined;
  /** Overridable in tests; absolute epoch ms deadline for the derivatives sweep. */
  derivativesDeadlineMs?: number;
}

/**
 * Do the delete. Ordered so that a failure or a request kill anywhere leaves a
 * state a re-run can finish: revoke → trash + ledger → sweep derivatives → drop
 * the Sheet row → drop the Firestore caches.
 */
export async function deleteEvent(
  spreadsheetId: string,
  eventId: string,
  opts: DeleteEventOptions,
): Promise<ServiceResult<DeleteEventResponse>> {
  const event = await resolveEvent(spreadsheetId, eventId);
  if (!event) return { ok: false, message: `Event "${eventId}" not found in the Sheet or the events cache` };

  const inventory = await inventoryEvent(spreadsheetId, event);
  const body = baseResponse(event, inventory);
  body.apply = true;
  const warnings = inventoryWarnings(inventory);
  const label = event.name || eventId;

  // 1. Revoke the upload links first: a link that outlives its event is a way to
  //    push photos into a folder nobody is watching any more.
  const links = await listLinks(spreadsheetId, { eventId }).catch((err: unknown) => {
    logger.warn({ err, eventId }, 'event delete: link listing failed');
    warnings.push('Could not list upload links — revoke them by hand.');
    return [];
  });
  for (const link of links.filter((l) => l.status === UserStatus.ACTIVE)) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await revokeLink(spreadsheetId, link.linkId, opts.reason?.trim() || `Event deleted (${label})`, opts.actorEmail);
      body.removed.linksRevoked += 1;
    } catch (err) {
      logger.warn({ err, eventId, linkId: link.linkId }, 'event delete: link revoke failed');
      warnings.push(`Could not revoke link ${link.linkId}.`);
    }
  }

  // 2. Drive folder → trash, then ledger it. The row is written only AFTER the
  //    trash call succeeds, so Deleted_Files never claims a delete that didn't
  //    happen (the G5.1 rule). Restoring that one folder brings the event's whole
  //    file tree back.
  if (inventory.driveFolderExists && event.driveFolderId) {
    try {
      await trashFile(event.driveFolderId);
      body.driveFolderTrashed = true;
      try {
        const rec = await recordSoftDelete(
          spreadsheetId,
          {
            driveFileId: event.driveFolderId,
            fileName: event.folderName || label,
            eventId,
            clubName: '',
            reason: opts.reason?.trim() || `Event deleted (${label})`,
          },
          opts.actorEmail,
        );
        body.deleteId = rec.deleteId;
      } catch (err) {
        logger.warn({ err, eventId }, 'event delete: Deleted_Files ledger write failed');
        warnings.push(
          `The Drive folder was trashed but the Deleted_Files row failed — restore it directly in Drive (folder ${event.driveFolderId}).`,
        );
      }
    } catch (err) {
      logger.warn({ err, eventId, driveFolderId: event.driveFolderId }, 'event delete: Drive folder trash failed');
      warnings.push(`Could not trash the Drive folder ${event.driveFolderId} — the files are still there.`);
    }
  }

  // 3. Managed-folder bookkeeping: the folders themselves went with the event
  //    folder in step 2, so this only clears the rows that point at them.
  try {
    const rows = await listAllSpecialFolders(spreadsheetId);
    const folderIds = new Set(rows.filter((r) => r.eventId === eventId).map((r) => r.folderId));
    if (folderIds.size > 0) {
      body.removed.specialFolderRows = await deleteSpecialFolderRowsByFolderId(spreadsheetId, folderIds);
    }
  } catch (err) {
    logger.warn({ err, eventId }, 'event delete: Special_Folders cleanup failed');
    warnings.push('Could not clear the Special_Folders rows for this event.');
  }

  // 4. The derivatives sweep — the one step that can run out of request budget.
  //    Bail out BEFORE the identity records when it does (see the file header).
  const deadlineMs = opts.derivativesDeadlineMs ?? Date.now() + DERIVATIVES_BUDGET_MS;
  try {
    const sweep = await deleteEventDerivatives(eventId, { deadlineMs });
    body.removed.derivativeObjects = sweep.deleted;
    body.derivativesRemaining = sweep.remaining;
  } catch (err) {
    logger.warn({ err, eventId }, 'event delete: derivatives sweep failed');
    warnings.push('Could not delete the derivatives objects — re-run to retry.');
  }

  if (body.derivativesRemaining) {
    body.warnings = warnings;
    body.message =
      `Partly done: trashed the Drive folder and removed ${body.removed.derivativeObjects} derivative object(s), ` +
      'but the bucket sweep ran out of time. The event is still listed — run the same delete again to finish it.';
    logger.info({ eventId, removed: body.removed }, 'event delete paused: derivatives remaining');
    return { ok: true, message: body.message, data: body };
  }

  // 5. Sheet row FIRST, then the Firestore caches — the other order lets the next
  //    reconcile tick recreate the event from the surviving Sheet row.
  try {
    body.removed.sheetRowsRemoved = await deleteEventRow(spreadsheetId, eventId);
  } catch (err) {
    logger.warn({ err, eventId }, 'event delete: Events row delete failed');
    warnings.push(
      'Could not delete the Events row in the Sheet. The Firestore docs were left in place too, since the ' +
        'reconciler would recreate them from that row — fix the Sheet write and re-run.',
    );
    body.warnings = warnings;
    body.message = `Stopped: "${label}" still has its Sheet row, so nothing downstream was deleted.`;
    return { ok: true, message: body.message, data: body };
  }

  for (const collection of EVENT_SCOPED_COLLECTIONS) {
    try {
      // eslint-disable-next-line no-await-in-loop
      body.removed.firestoreDocs += await deleteScoped(collection, eventId);
    } catch (err) {
      logger.warn({ err, eventId, collection }, 'event delete: Firestore cleanup failed');
      warnings.push(`Could not delete every ${collection} doc — re-run to finish.`);
    }
  }
  // specialFolders docs are keyed by folderId (they carry eventId as a field), so
  // they sit outside EVENT_SCOPED_COLLECTIONS but delete by the same query.
  try {
    body.removed.firestoreDocs += await deleteScoped('specialFolders', eventId);
  } catch (err) {
    logger.warn({ err, eventId }, 'event delete: specialFolders cache cleanup failed');
    warnings.push('Could not delete every specialFolders doc — re-run to finish.');
  }
  try {
    await firestore().collection('events').doc(eventId).delete();
    body.removed.firestoreDocs += 1;
  } catch (err) {
    logger.warn({ err, eventId }, 'event delete: events doc delete failed');
    warnings.push('Could not delete the events cache doc — the event may still appear in the list; re-run.');
  }

  // The public folder index lists managed albums per event; refresh it once so the
  // deleted event drops out. Best-effort by design (tryRebuild never throws).
  if (body.removed.specialFolderRows > 0) await tryRebuildPublicFolderIndex();

  body.warnings = warnings;
  body.message =
    `Deleted "${label}": revoked ${body.removed.linksRevoked} link(s), trashed the Drive folder, removed ` +
    `${body.removed.derivativeObjects} derivative object(s), ${body.removed.sheetRowsRemoved} Sheet row(s) and ` +
    `${body.removed.firestoreDocs} Firestore doc(s).` +
    (body.deleteId ? ' Restore the folder from the admin "Deleted files" page while it is still in trash.' : '');
  logger.info({ eventId, removed: body.removed, by: opts.actorEmail }, 'event deleted');
  return { ok: true, message: body.message, data: body };
}
