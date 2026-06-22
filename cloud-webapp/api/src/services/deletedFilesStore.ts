/**
 * deletedFilesStore.ts — soft-delete ledger for Drive files, Google Sheet as
 * SSOT (dev plan G5.1). Mirrors gas-app COLUMNS.DELETED_FILES. The Drive
 * trash/untrash/permanent-delete itself is done by the route via driveService;
 * this module is the auditable record of state (deleted → restored | purged).
 */

import { randomUUID } from 'node:crypto';

import { appendSheetValues, updateSheetValues } from './sheetsService.js';
import { cell, readTab, rowRange, withTabLock } from './sheetTable.js';

const TAB = 'Deleted_Files';
const LAST_COL = 'N';
const COL = {
  DELETE_ID: 0,
  DRIVE_FILE_ID: 1,
  FILE_NAME: 2,
  EVENT_ID: 3,
  CLUB_NAME: 4,
  BATCH_FOLDER_NAME: 5,
  UPLOADED_BY: 6,
  DELETED_AT: 7,
  DELETED_BY: 8,
  DELETED_REASON: 9,
  RESTORED_AT: 10,
  RESTORED_BY: 11,
  PURGED_AT: 12,
  STATUS: 13,
} as const;
const WIDTH = 14; // A..N

export type DeletedStatus = 'deleted' | 'restored' | 'purged';

export interface DeletedFile {
  deleteId: string;
  driveFileId: string;
  fileName: string;
  eventId: string;
  clubName: string;
  batchFolderName: string;
  uploadedBy: string;
  deletedAt: string;
  deletedBy: string;
  deletedReason: string;
  restoredAt: string;
  restoredBy: string;
  purgedAt: string;
  status: DeletedStatus;
}

export class DeletedFilesError extends Error {
  constructor(
    public code: 'invalid' | 'not_found' | 'bad_state',
    message: string,
  ) {
    super(message);
    this.name = 'DeletedFilesError';
  }
}

function rowToRec(cells: string[]): DeletedFile {
  const status = cell(cells, COL.STATUS);
  return {
    deleteId: cell(cells, COL.DELETE_ID),
    driveFileId: cell(cells, COL.DRIVE_FILE_ID),
    fileName: cell(cells, COL.FILE_NAME),
    eventId: cell(cells, COL.EVENT_ID),
    clubName: cell(cells, COL.CLUB_NAME),
    batchFolderName: cell(cells, COL.BATCH_FOLDER_NAME),
    uploadedBy: cell(cells, COL.UPLOADED_BY),
    deletedAt: cell(cells, COL.DELETED_AT),
    deletedBy: cell(cells, COL.DELETED_BY),
    deletedReason: cell(cells, COL.DELETED_REASON),
    restoredAt: cell(cells, COL.RESTORED_AT),
    restoredBy: cell(cells, COL.RESTORED_BY),
    purgedAt: cell(cells, COL.PURGED_AT),
    status: (status === 'restored' || status === 'purged' ? status : 'deleted') as DeletedStatus,
  };
}

function recToRow(r: DeletedFile): string[] {
  const row = new Array(WIDTH).fill('');
  row[COL.DELETE_ID] = r.deleteId;
  row[COL.DRIVE_FILE_ID] = r.driveFileId;
  row[COL.FILE_NAME] = r.fileName;
  row[COL.EVENT_ID] = r.eventId;
  row[COL.CLUB_NAME] = r.clubName;
  row[COL.BATCH_FOLDER_NAME] = r.batchFolderName;
  row[COL.UPLOADED_BY] = r.uploadedBy;
  row[COL.DELETED_AT] = r.deletedAt;
  row[COL.DELETED_BY] = r.deletedBy;
  row[COL.DELETED_REASON] = r.deletedReason;
  row[COL.RESTORED_AT] = r.restoredAt;
  row[COL.RESTORED_BY] = r.restoredBy;
  row[COL.PURGED_AT] = r.purgedAt;
  row[COL.STATUS] = r.status;
  return row;
}

export async function listDeleted(
  spreadsheetId: string,
  filter?: { clubName?: string; status?: DeletedStatus; eventId?: string },
): Promise<DeletedFile[]> {
  const rows = await readTab(spreadsheetId, TAB, LAST_COL, COL.DELETE_ID, 'deleteid');
  let recs = rows.map((r) => rowToRec(r.cells));
  if (filter?.clubName !== undefined) recs = recs.filter((r) => r.clubName === filter.clubName);
  if (filter?.status !== undefined) recs = recs.filter((r) => r.status === filter.status);
  if (filter?.eventId !== undefined) recs = recs.filter((r) => r.eventId === filter.eventId);
  return recs;
}

export async function recordSoftDelete(
  spreadsheetId: string,
  input: {
    driveFileId: string;
    fileName?: string | undefined;
    eventId?: string | undefined;
    clubName: string;
    batchFolderName?: string | undefined;
    uploadedBy?: string | undefined;
    reason?: string | undefined;
  },
  actorEmail: string,
): Promise<DeletedFile> {
  if (!input.driveFileId.trim()) throw new DeletedFilesError('invalid', 'driveFileId is required');
  return withTabLock(TAB, async () => {
    const rec: DeletedFile = {
      deleteId: randomUUID(),
      driveFileId: input.driveFileId.trim(),
      fileName: input.fileName ?? '',
      eventId: input.eventId ?? '',
      clubName: input.clubName ?? '',
      batchFolderName: input.batchFolderName ?? '',
      uploadedBy: input.uploadedBy ?? '',
      deletedAt: new Date().toISOString(),
      deletedBy: actorEmail.trim().toLowerCase(),
      deletedReason: input.reason ?? '',
      restoredAt: '',
      restoredBy: '',
      purgedAt: '',
      status: 'deleted',
    };
    await appendSheetValues(spreadsheetId, `${TAB}!A1`, [recToRow(rec)]);
    return rec;
  });
}

async function findRow(spreadsheetId: string, deleteId: string) {
  const rows = await readTab(spreadsheetId, TAB, LAST_COL, COL.DELETE_ID, 'deleteid');
  return rows.find((r) => cell(r.cells, COL.DELETE_ID) === deleteId) ?? null;
}

export async function markRestored(
  spreadsheetId: string,
  deleteId: string,
  actorEmail: string,
): Promise<DeletedFile> {
  return withTabLock(TAB, async () => {
    const hit = await findRow(spreadsheetId, deleteId);
    if (!hit) throw new DeletedFilesError('not_found', `Delete record not found: ${deleteId}`);
    const rec = rowToRec(hit.cells);
    if (rec.status !== 'deleted') {
      throw new DeletedFilesError('bad_state', `Cannot restore a ${rec.status} record`);
    }
    const updated: DeletedFile = {
      ...rec,
      restoredAt: new Date().toISOString(),
      restoredBy: actorEmail.trim().toLowerCase(),
      status: 'restored',
    };
    await updateSheetValues(spreadsheetId, rowRange(TAB, 'A', LAST_COL, hit.rowNumber), [recToRow(updated)]);
    return updated;
  });
}

export async function markPurged(spreadsheetId: string, deleteId: string): Promise<DeletedFile> {
  return withTabLock(TAB, async () => {
    const hit = await findRow(spreadsheetId, deleteId);
    if (!hit) throw new DeletedFilesError('not_found', `Delete record not found: ${deleteId}`);
    const rec = rowToRec(hit.cells);
    const updated: DeletedFile = { ...rec, purgedAt: new Date().toISOString(), status: 'purged' };
    await updateSheetValues(spreadsheetId, rowRange(TAB, 'A', LAST_COL, hit.rowNumber), [recToRow(updated)]);
    return updated;
  });
}

/** Soft-deleted records whose deletedAt is older than `retentionDays` (purge candidates). */
export async function findExpired(spreadsheetId: string, retentionDays: number): Promise<DeletedFile[]> {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const deleted = await listDeleted(spreadsheetId, { status: 'deleted' });
  return deleted.filter((r) => {
    const t = Date.parse(r.deletedAt);
    return Number.isFinite(t) && t < cutoff;
  });
}
