/**
 * reconcileService.ts — the cloud side of "Sync with Drive" (dev plan §8).
 *
 * Reads the master Google Sheet (the gas-app source of truth) and upserts its
 * events + per-event tags into Firestore so the cloud webapp's gallery and
 * Find Me see the same events without anyone re-entering them by hand.
 *
 * Policy (chosen 2026-06-15): **report-only**.
 *   - Each Sheet event row is upserted with `merge: true`, so cloud-owned
 *     fields the indexer/admin write (`indexState`, `visibility`) are never
 *     clobbered — only the Sheet-derived fields are touched.
 *   - Writes happen only when content actually changed, so a no-op sync is a
 *     no-op (idempotent), and `lastSyncedAt` doesn't churn every run.
 *   - Events present in Firestore but absent from the Sheet are returned as
 *     `orphans`. They are NOT deleted; Drive/Sheets stays authoritative and
 *     additive.
 *
 * Column layout mirrors gas-app `SheetColumns` (gas-app/src/config/constants.ts)
 * — keep these in sync if the Sheet schema ever changes.
 */

import type { SyncEventResult, SyncResult } from '@cloud-webapp/shared';

import { firestore } from '../lib/firestore.js';
import { env } from '../lib/config.js';
import { getSheetValues } from './sheetsService.js';

// 0-based column indices, mirroring gas-app SheetColumns.EVENTS / .UPLOAD_LINKS.
const EVENTS_COL = {
  EVENT_ID: 0,
  EVENT_NAME: 1,
  EVENT_DATE: 2,
  FOLDER_NAME: 3,
  DRIVE_FOLDER_ID: 4,
} as const;
const LINKS_COL = { EVENT_ID: 1, TAG: 10 } as const;

export interface SheetEvent {
  eventId: string;
  name: string;
  date: string;
  folderName: string;
  driveFolderId: string;
}

/** Sheet-derived event fields written to Firestore (excludes `lastSyncedAt`,
 *  which is metadata, and the cloud-owned `indexState`/`visibility`). */
export interface EventContent {
  name: string;
  date: string;
  folderName: string;
  driveFolderId: string;
  tags: string[];
}

const cell = (row: string[], i: number): string => (row[i] ?? '').trim();

/** A leading row is a header if its EVENT_ID-position cell reads "eventid"
 *  (case/underscore-insensitive). gas-app writes such a header row. */
function isHeaderRow(row: string[] | undefined, eventIdCol: number): boolean {
  if (!row) return false;
  return cell(row, eventIdCol).toLowerCase().replace(/[\s_]/g, '') === 'eventid';
}

/** Parse the Events tab into typed rows; skips the header and blank rows. */
export function parseEventRows(values: string[][]): SheetEvent[] {
  const rows = isHeaderRow(values[0], EVENTS_COL.EVENT_ID) ? values.slice(1) : values;
  const out: SheetEvent[] = [];
  for (const row of rows) {
    const eventId = cell(row, EVENTS_COL.EVENT_ID);
    if (!eventId) continue; // blank/spacer row
    out.push({
      eventId,
      name: cell(row, EVENTS_COL.EVENT_NAME),
      date: cell(row, EVENTS_COL.EVENT_DATE),
      folderName: cell(row, EVENTS_COL.FOLDER_NAME),
      driveFolderId: cell(row, EVENTS_COL.DRIVE_FOLDER_ID),
    });
  }
  return out;
}

/** Distinct, sorted, non-empty tags per eventId from the Upload_Links tab.
 *  Revoked links still contribute their tag — the tag names a Drive subfolder
 *  that may still hold photos. The empty/legacy tag ('' = "directly under
 *  Club/") carries no label and is skipped. */
export function parseTagsByEvent(values: string[][]): Map<string, string[]> {
  const rows = isHeaderRow(values[0], LINKS_COL.EVENT_ID) ? values.slice(1) : values;
  const sets = new Map<string, Set<string>>();
  for (const row of rows) {
    const eventId = cell(row, LINKS_COL.EVENT_ID);
    if (!eventId) continue;
    const tag = cell(row, LINKS_COL.TAG);
    if (!tag) continue;
    if (!sets.has(eventId)) sets.set(eventId, new Set());
    sets.get(eventId)!.add(tag);
  }
  const out = new Map<string, string[]>();
  for (const [eventId, set] of sets) out.set(eventId, [...set].sort());
  return out;
}

export function buildContent(ev: SheetEvent, tags: string[]): EventContent {
  return {
    name: ev.name,
    date: ev.date,
    folderName: ev.folderName,
    driveFolderId: ev.driveFolderId,
    tags,
  };
}

/** True when the existing Firestore doc already matches the Sheet-derived
 *  content (so no write is needed). Missing string fields compare as ''. */
export function contentEquals(prev: Record<string, unknown> | undefined, next: EventContent): boolean {
  if (!prev) return false;
  const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));
  if (str(prev.name) !== next.name) return false;
  if (str(prev.date) !== next.date) return false;
  if (str(prev.folderName) !== next.folderName) return false;
  if (str(prev.driveFolderId) !== next.driveFolderId) return false;
  const prevTags = Array.isArray(prev.tags) ? [...(prev.tags as unknown[])].map(String).sort() : [];
  if (prevTags.length !== next.tags.length) return false;
  return prevTags.every((t, i) => t === next.tags[i]);
}

/**
 * Run a full reconcile against the given master Sheet. Reads the Events +
 * Upload_Links tabs and the current `events` collection, then upserts changed
 * rows. Returns a per-event report plus rollup counts and the orphan list.
 */
export async function reconcile(spreadsheetId: string): Promise<SyncResult> {
  const t0 = Date.now();
  const db = firestore();

  const [eventValues, linkValues] = await Promise.all([
    getSheetValues(spreadsheetId, `${env.EVENTS_SHEET_NAME}!A1:G`),
    getSheetValues(spreadsheetId, `${env.UPLOAD_LINKS_SHEET_NAME}!A1:K`),
  ]);

  const sheetEvents = parseEventRows(eventValues);
  const tagsByEvent = parseTagsByEvent(linkValues);

  // Snapshot existing docs once: drives both change-detection and orphan finding.
  const snap = await db.collection('events').get();
  const existing = new Map<string, Record<string, unknown>>();
  for (const d of snap.docs) existing.set(d.id, d.data() as Record<string, unknown>);

  const events: SyncEventResult[] = [];
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  let tagsLinked = 0;
  const now = new Date().toISOString();
  const sheetIds = new Set<string>();

  for (const ev of sheetEvents) {
    sheetIds.add(ev.eventId);
    const tags = tagsByEvent.get(ev.eventId) ?? [];
    tagsLinked += tags.length;
    const content = buildContent(ev, tags);
    const prev = existing.get(ev.eventId);

    let action: SyncEventResult['action'];
    if (!prev) action = 'created';
    else if (!contentEquals(prev, content)) action = 'updated';
    else action = 'unchanged';

    if (action !== 'unchanged') {
      await db
        .collection('events')
        .doc(ev.eventId)
        .set({ ...content, source: 'sheet-sync', lastSyncedAt: now }, { merge: true });
    }

    if (action === 'created') created += 1;
    else if (action === 'updated') updated += 1;
    else unchanged += 1;

    events.push({ eventId: ev.eventId, name: ev.name, action, tags });
  }

  const orphans = [...existing.keys()].filter((id) => !sheetIds.has(id)).sort();

  return {
    spreadsheetId,
    scanned: sheetEvents.length,
    created,
    updated,
    unchanged,
    tagsLinked,
    orphans,
    events,
    durationMs: Date.now() - t0,
  };
}
