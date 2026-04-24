/**
 * manifestService.ts — Read and write Upload Prep manifest and index CSV files.
 *
 * Per-event manifest: _UploadPrep/<EventName>/_manifest.csv
 *   One row per source file attempted (including skipped). See §4.1 for columns.
 *   On re-run: existing rows are kept and new rows are appended.
 *
 * Global index: _UploadPrep/_index.csv
 *   One row per event that has been prepped. Overwrite the matching row each run.
 *
 * Both files are written as UTF-8 with BOM so Excel opens them correctly.
 * Fields containing commas, double-quotes, or newlines are properly quoted.
 *
 * See UPLOAD_PREP_FEATURE_SPEC.md §4 for full specification.
 */

/* global DriveApp, Utilities, Logger */

// ─── Types ────────────────────────────────────────────────────────────────────

/** One row in _manifest.csv (§4.1). */
export interface ManifestRow {
  readonly event_name: string;
  readonly source_file_id: string;
  readonly source_name: string;
  readonly source_mime_type: string;
  readonly source_md5_checksum: string;
  readonly source_size_bytes: string;
  readonly source_modified_time: string;
  readonly dest_file_id: string;
  readonly dest_name: string;
  readonly action: ManifestAction;
  readonly skip_reason: string;
  readonly jpg_quality: string;
  readonly exif_preserved: string;
  readonly processed_at: string;
  readonly run_id: string;
}

/** One row in _index.csv (§4.2). */
export interface IndexRow {
  readonly event_name: string;
  readonly event_folder_id: string;
  readonly prep_folder_id: string;
  readonly last_run_id: string;
  readonly last_run_at: string;
  readonly last_run_by: string;
  readonly files_total: number;
  readonly files_copied: number;
  readonly files_converted: number;
  readonly files_skipped: number;
  readonly files_errored: number;
}

export type ManifestAction =
  | 'copied'
  | 'converted'
  | 'skipped'
  | 'would_copy'
  | 'would_convert'
  | 'would_skip'
  | 'error';

// ─── CSV constants ────────────────────────────────────────────────────────────

const MANIFEST_HEADERS: ReadonlyArray<string> = [
  'event_name',
  'source_file_id',
  'source_name',
  'source_mime_type',
  'source_md5_checksum',
  'source_size_bytes',
  'source_modified_time',
  'dest_file_id',
  'dest_name',
  'action',
  'skip_reason',
  'jpg_quality',
  'exif_preserved',
  'processed_at',
  'run_id',
];

const INDEX_HEADERS: ReadonlyArray<string> = [
  'event_name',
  'event_folder_id',
  'prep_folder_id',
  'last_run_id',
  'last_run_at',
  'last_run_by',
  'files_total',
  'files_copied',
  'files_converted',
  'files_skipped',
  'files_errored',
];

/** UTF-8 BOM — makes Excel auto-detect UTF-8 on open. */
const UTF8_BOM = '\uFEFF';

// ─── CSV helpers ──────────────────────────────────────────────────────────────

/**
 * Quotes a single CSV field if it contains commas, double-quotes, or newlines.
 * Embedded double-quotes are escaped by doubling them ("").
 */
export function escapeCsvField(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n') || value.includes('\r')) {
    return '"' + value.replace(/"/g, '""') + '"';
  }
  return value;
}

/** Serializes a row of string values to a CSV line (no trailing newline). */
export function serializeCsvRow(fields: ReadonlyArray<string>): string {
  return fields.map(escapeCsvField).join(',');
}

/**
 * Parses CSV text into a 2-D string array.
 * Uses GAS's built-in Utilities.parseCsv for correctness (handles quoted fields).
 * Returns an empty array if the input is empty.
 */
function parseCsvText(text: string): string[][] {
  const stripped = text.startsWith(UTF8_BOM) ? text.slice(1) : text;
  if (!stripped.trim()) return [];
  return Utilities.parseCsv(stripped) as string[][];
}

/** Constructs a full CSV string (BOM + header + rows) from an array of string arrays. */
function buildCsvText(headers: ReadonlyArray<string>, rows: ReadonlyArray<ReadonlyArray<string>>): string {
  const lines = [serializeCsvRow(headers), ...rows.map(r => serializeCsvRow(r))];
  return UTF8_BOM + lines.join('\r\n') + '\r\n';
}

// ─── Drive file helpers ───────────────────────────────────────────────────────

/**
 * Finds a file by name inside a Drive folder.
 * Returns the first match, or null if none exists.
 */
function findFileByName(
  folder: GoogleAppsScript.Drive.Folder,
  fileName: string
): GoogleAppsScript.Drive.File | null {
  const iter = folder.getFilesByName(fileName);
  return iter.hasNext() ? iter.next() : null;
}

/**
 * Writes text content to a named file in the given Drive folder.
 * Creates the file if it does not exist; overwrites content if it does.
 */
function writeDriveTextFile(
  folder: GoogleAppsScript.Drive.Folder,
  fileName: string,
  content: string
): GoogleAppsScript.Drive.File {
  const existing = findFileByName(folder, fileName);
  if (existing) {
    existing.setContent(content);
    return existing;
  }
  const blob = Utilities.newBlob(content, 'text/csv', fileName);
  return folder.createFile(blob);
}

/**
 * Reads the text content of a named file in the given Drive folder.
 * Returns null if the file does not exist.
 */
function readDriveTextFile(
  folder: GoogleAppsScript.Drive.Folder,
  fileName: string
): string | null {
  const file = findFileByName(folder, fileName);
  if (!file) return null;
  return file.getBlob().getDataAsString('UTF-8');
}

// ─── Manifest (per-event) ─────────────────────────────────────────────────────

/**
 * Loads all rows from the per-event manifest CSV.
 * Returns an empty array if the manifest file does not yet exist.
 *
 * @param prepFolderId - Drive ID of the per-event _UploadPrep/<EventName>/ folder.
 */
export function loadManifest(prepFolderId: string): ManifestRow[] {
  try {
    const folder = DriveApp.getFolderById(prepFolderId);
    const { MANIFEST_FILENAME } = require('../config/superAdmins') as typeof import('../config/superAdmins');
    const raw = readDriveTextFile(folder, MANIFEST_FILENAME);
    if (!raw) return [];

    const rows = parseCsvText(raw);
    if (rows.length < 2) return []; // header only or empty

    const header = rows[0];
    return rows.slice(1).map(row => rowToManifestRow(header, row));
  } catch (err) {
    Logger.log(`[manifestService.loadManifest] Error reading manifest for folder ${prepFolderId}: ${String(err)}`);
    return [];
  }
}

/** Maps a parsed CSV row to a ManifestRow using the header for column lookup. */
function rowToManifestRow(header: string[], row: string[]): ManifestRow {
  const get = (col: string): string => row[header.indexOf(col)] ?? '';
  return {
    event_name:           get('event_name'),
    source_file_id:       get('source_file_id'),
    source_name:          get('source_name'),
    source_mime_type:     get('source_mime_type'),
    source_md5_checksum:  get('source_md5_checksum'),
    source_size_bytes:    get('source_size_bytes'),
    source_modified_time: get('source_modified_time'),
    dest_file_id:         get('dest_file_id'),
    dest_name:            get('dest_name'),
    action:               get('action') as ManifestAction,
    skip_reason:          get('skip_reason'),
    jpg_quality:          get('jpg_quality'),
    exif_preserved:       get('exif_preserved'),
    processed_at:         get('processed_at'),
    run_id:               get('run_id'),
  };
}

/** Serializes a ManifestRow to a CSV field array in header column order. */
function manifestRowToFields(row: ManifestRow): string[] {
  return [
    row.event_name,
    row.source_file_id,
    row.source_name,
    row.source_mime_type,
    row.source_md5_checksum,
    row.source_size_bytes,
    row.source_modified_time,
    row.dest_file_id,
    row.dest_name,
    row.action,
    row.skip_reason,
    row.jpg_quality,
    row.exif_preserved,
    row.processed_at,
    row.run_id,
  ];
}

/**
 * Writes all manifest rows to the per-event manifest CSV.
 * Overwrites the entire file (header + all rows).
 *
 * @param prepFolderId - Drive ID of the per-event _UploadPrep/<EventName>/ folder.
 * @param rows         - All rows to write (existing + new).
 */
export function writeManifest(prepFolderId: string, rows: ManifestRow[]): void {
  const { MANIFEST_FILENAME } = require('../config/superAdmins') as typeof import('../config/superAdmins');
  const folder = DriveApp.getFolderById(prepFolderId);
  const csv = buildCsvText(MANIFEST_HEADERS, rows.map(manifestRowToFields));
  writeDriveTextFile(folder, MANIFEST_FILENAME, csv);
  Logger.log(`[manifestService.writeManifest] Wrote ${rows.length} rows to manifest in folder ${prepFolderId}`);
}

// ─── Index (global) ───────────────────────────────────────────────────────────

/**
 * Loads all rows from the global _index.csv.
 * Returns an empty array if the file does not yet exist.
 *
 * @param uploadPrepRootFolderId - Drive ID of the _UploadPrep/ root folder.
 */
export function loadIndex(uploadPrepRootFolderId: string): IndexRow[] {
  try {
    const folder = DriveApp.getFolderById(uploadPrepRootFolderId);
    const { INDEX_FILENAME } = require('../config/superAdmins') as typeof import('../config/superAdmins');
    const raw = readDriveTextFile(folder, INDEX_FILENAME);
    if (!raw) return [];

    const rows = parseCsvText(raw);
    if (rows.length < 2) return [];

    const header = rows[0];
    return rows.slice(1).map(row => rowToIndexRow(header, row));
  } catch (err) {
    Logger.log(`[manifestService.loadIndex] Error reading index for folder ${uploadPrepRootFolderId}: ${String(err)}`);
    return [];
  }
}

/** Maps a parsed CSV row to an IndexRow. */
function rowToIndexRow(header: string[], row: string[]): IndexRow {
  const get = (col: string): string => row[header.indexOf(col)] ?? '';
  return {
    event_name:       get('event_name'),
    event_folder_id:  get('event_folder_id'),
    prep_folder_id:   get('prep_folder_id'),
    last_run_id:      get('last_run_id'),
    last_run_at:      get('last_run_at'),
    last_run_by:      get('last_run_by'),
    files_total:      Number(get('files_total')) || 0,
    files_copied:     Number(get('files_copied')) || 0,
    files_converted:  Number(get('files_converted')) || 0,
    files_skipped:    Number(get('files_skipped')) || 0,
    files_errored:    Number(get('files_errored')) || 0,
  };
}

/** Serializes an IndexRow to CSV fields in header column order. */
function indexRowToFields(row: IndexRow): string[] {
  return [
    row.event_name,
    row.event_folder_id,
    row.prep_folder_id,
    row.last_run_id,
    row.last_run_at,
    row.last_run_by,
    String(row.files_total),
    String(row.files_copied),
    String(row.files_converted),
    String(row.files_skipped),
    String(row.files_errored),
  ];
}

/**
 * Upserts a row in the global index CSV.
 * Replaces the row matching `row.event_name`, or appends if not found.
 *
 * @param uploadPrepRootFolderId - Drive ID of the _UploadPrep/ root folder.
 * @param row                   - Updated index row for this event.
 */
export function upsertIndex(uploadPrepRootFolderId: string, row: IndexRow): void {
  const { INDEX_FILENAME } = require('../config/superAdmins') as typeof import('../config/superAdmins');
  const folder = DriveApp.getFolderById(uploadPrepRootFolderId);

  const existing = loadIndex(uploadPrepRootFolderId);
  const idx = existing.findIndex(r => r.event_name === row.event_name);
  const updated = idx >= 0
    ? existing.map((r, i) => (i === idx ? row : r))
    : [...existing, row];

  const csv = buildCsvText(INDEX_HEADERS, updated.map(indexRowToFields));
  writeDriveTextFile(folder, INDEX_FILENAME, csv);
  Logger.log(`[manifestService.upsertIndex] Updated index for event "${row.event_name}"`);
}
