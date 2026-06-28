/**
 * driveShortcutClient.ts — Drive v3 REST helpers for shortcut files and
 * server-side copies. Cloud-webapp port of the gas-app module of the same name.
 *
 * Native Drive shortcuts (mimeType `application/vnd.google-apps.shortcut`) point
 * to a target file by ID and inherit the target's preview/permissions; a
 * trash/restore on the target is reflected automatically. The managed-folders
 * rebuild (specialFoldersService) uses them for the Videos/Album folders and —
 * under the storage-minimizing policy — for JPEG sources in the Photos_NNN
 * buckets too. Non-JPEG sources are materialised as real converted JPGs via
 * `files.copy` (with an `appProperties.sourcePhotoId` tag) so dedupe and the
 * orphan sweep can find them.
 *
 * Style: async `fetch` + a write-scoped DWD token (driveService.getDriveToken),
 * matching driveService.ts. Unlike driveService's throw-on-error helpers, the
 * functions here return `{ ok, status, error }` envelopes: the rebuild engine
 * collects soft errors into a `warnings[]` and must never throw mid-rebuild.
 * `supportsAllDrives=true` is set everywhere so Shared-Drive event folders work.
 */

import { getDriveToken, DRIVE_SCOPE_READWRITE } from './driveService.js';
import { driveFetch } from './driveRateLimit.js';
import { logger } from '../lib/logger.js';

export const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';

/** MIME type Drive uses for shortcut files. */
export const DRIVE_SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';

/** MIME type Drive uses for folders. */
export const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';

/**
 * appProperties key stamped on every real file materialised into a managed
 * folder (e.g. a converted JPG in a Photos_NNN bucket). Its value is the Drive
 * ID of the ORIGINAL source photo. This is the copy-world analogue of a
 * shortcut's `shortcutDetails.targetId`: it lets the rebuild dedupe and lets the
 * orphan sweep retire a copy when its source is deleted.
 */
export const SOURCE_PHOTO_ID_PROPERTY = 'sourcePhotoId';

/** Drive files.list page cap. */
const LIST_PAGE_SIZE = 1000;

// ─── Types ────────────────────────────────────────────────────────────────────

/** A shortcut entry from files.list (with shortcutDetails). */
export interface ShortcutEntry {
  id: string;
  name: string;
  targetId: string;
  /** MIME of the target (shortcutDetails.targetMimeType); '' when Drive omits it. */
  targetMimeType?: string;
}

/** A real (non-shortcut) file we materialised, carrying its sourcePhotoId tag. */
export interface ManagedCopyEntry {
  id: string;
  name: string;
  sourcePhotoId: string;
}

export interface CreateShortcutResult {
  ok: boolean;
  shortcutId?: string;
  error?: string;
  status: number;
}

export interface CopyFileResult {
  ok: boolean;
  fileId?: string;
  error?: string;
  status: number;
}

export interface UpdateFileResult {
  ok: boolean;
  error?: string;
  status: number;
}

export interface TrashFileResult {
  ok: boolean;
  error?: string;
  status: number;
}

export interface DriveFileBasics {
  id: string;
  name: string;
  mimeType: string;
}

/**
 * Single-file lookup result. Distinguishes a definitive "gone" (404) from an
 * ambiguous transient error so callers can decide whether to treat a missing
 * target as dangling (trash it) versus retry later.
 */
export type DriveFileLookup =
  | { found: true; file: DriveFileBasics }
  | { found: false; gone: boolean };

// ─── HTTP helper ──────────────────────────────────────────────────────────────

const authHeaders = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
});

async function token(opts?: { token?: string }): Promise<string> {
  return opts?.token ?? (await getDriveToken(DRIVE_SCOPE_READWRITE));
}

// ─── Shortcut creation ─────────────────────────────────────────────────────────

/**
 * Creates a shortcut inside `parentFolderId` pointing at `targetFileId`.
 */
export async function createDriveShortcut(
  parentFolderId: string,
  targetFileId: string,
  shortcutName: string,
  opts?: { token?: string },
): Promise<CreateShortcutResult> {
  const url = `${DRIVE_API_BASE}/files?fields=id&supportsAllDrives=true`;
  const body = {
    name: shortcutName,
    mimeType: DRIVE_SHORTCUT_MIME,
    parents: [parentFolderId],
    shortcutDetails: { targetId: targetFileId },
  };
  try {
    const res = await driveFetch(url, {
      method: 'POST',
      headers: { ...authHeaders(await token(opts)), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, 'createDriveShortcut');
    const text = await res.text();
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 300)}`, status: res.status };
    const parsed = JSON.parse(text) as { id?: string };
    if (!parsed.id) return { ok: false, error: `Malformed Drive response: ${text.slice(0, 200)}`, status: res.status };
    return { ok: true, shortcutId: parsed.id, status: res.status };
  } catch (err) {
    return { ok: false, error: String(err), status: 0 };
  }
}

// ─── Listing ────────────────────────────────────────────────────────────────────

async function listPaged<T>(
  q: string,
  fields: string,
  mapRow: (f: Record<string, unknown>) => T | null,
  logCtx: string,
  opts?: { token?: string },
): Promise<T[]> {
  const out: T[] = [];
  let pageToken: string | null = null;
  const tok = await token(opts);
  do {
    const params = new URLSearchParams({
      q,
      fields: `nextPageToken,${fields}`,
      pageSize: String(LIST_PAGE_SIZE),
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    });
    if (pageToken) params.set('pageToken', pageToken);
    try {
      const res = await driveFetch(`${DRIVE_API_BASE}/files?${params}`, { headers: authHeaders(tok) }, logCtx);
      const text = await res.text();
      if (!res.ok) {
        logger.warn({ status: res.status, ctx: logCtx, body: text.slice(0, 200) }, 'drive list failed (partial)');
        return out; // degrade gracefully — partial accumulation beats throwing
      }
      const parsed = JSON.parse(text) as { nextPageToken?: string; files?: Record<string, unknown>[] };
      for (const f of parsed.files ?? []) {
        const row = mapRow(f);
        if (row) out.push(row);
      }
      pageToken = parsed.nextPageToken ?? null;
    } catch (err) {
      logger.warn({ err, ctx: logCtx }, 'drive list threw (partial)');
      return out;
    }
  } while (pageToken);
  return out;
}

/** Lists every shortcut directly inside `parentFolderId` (non-recursive). */
export async function listShortcutsInFolder(
  parentFolderId: string,
  opts?: { token?: string },
): Promise<ShortcutEntry[]> {
  const q = `'${parentFolderId}' in parents and mimeType='${DRIVE_SHORTCUT_MIME}' and trashed=false`;
  return listPaged<ShortcutEntry>(
    q,
    'files(id,name,shortcutDetails/targetId,shortcutDetails/targetMimeType)',
    (f) => {
      const id = String(f.id ?? '').trim();
      const sd = (f.shortcutDetails ?? {}) as { targetId?: string; targetMimeType?: string };
      const targetId = String(sd.targetId ?? '').trim();
      if (!id || !targetId) return null;
      return {
        id,
        name: String(f.name ?? '').trim(),
        targetId,
        targetMimeType: String(sd.targetMimeType ?? '').trim(),
      };
    },
    `listShortcutsInFolder(${parentFolderId})`,
    opts,
  );
}

/**
 * Lists every real (non-shortcut, non-folder) file directly inside
 * `parentFolderId` that carries a `sourcePhotoId` appProperty — i.e. a file we
 * materialised. Human-dropped files (no tag) are skipped.
 */
export async function listManagedCopiesInFolder(
  parentFolderId: string,
  opts?: { token?: string },
): Promise<ManagedCopyEntry[]> {
  const q =
    `'${parentFolderId}' in parents and ` +
    `mimeType!='${DRIVE_SHORTCUT_MIME}' and mimeType!='${DRIVE_FOLDER_MIME}' and trashed=false`;
  return listPaged<ManagedCopyEntry>(
    q,
    'files(id,name,appProperties)',
    (f) => {
      const id = String(f.id ?? '').trim();
      const appProps = (f.appProperties ?? {}) as Record<string, string>;
      const sourcePhotoId = String(appProps[SOURCE_PHOTO_ID_PROPERTY] ?? '').trim();
      if (!id || !sourcePhotoId) return null;
      return { id, name: String(f.name ?? '').trim(), sourcePhotoId };
    },
    `listManagedCopiesInFolder(${parentFolderId})`,
    opts,
  );
}

// ─── Single-file metadata ───────────────────────────────────────────────────────

/** Fetches id/name/mimeType for one file; distinguishes 404 (gone) from transient. */
export async function getDriveFileBasics(fileId: string, opts?: { token?: string }): Promise<DriveFileLookup> {
  const url = `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType&supportsAllDrives=true`;
  try {
    const res = await driveFetch(url, { headers: authHeaders(await token(opts)) }, 'getDriveFileBasics');
    if (res.status === 404) return { found: false, gone: true };
    const text = await res.text();
    if (!res.ok) {
      logger.warn({ status: res.status, fileId, body: text.slice(0, 200) }, 'getDriveFileBasics failed');
      return { found: false, gone: false };
    }
    const parsed = JSON.parse(text) as { id?: string; name?: string; mimeType?: string };
    return {
      found: true,
      file: {
        id: String(parsed.id ?? fileId).trim(),
        name: String(parsed.name ?? '').trim(),
        mimeType: String(parsed.mimeType ?? '').trim(),
      },
    };
  } catch (err) {
    logger.warn({ err, fileId }, 'getDriveFileBasics threw');
    return { found: false, gone: false };
  }
}

// ─── Mutations ──────────────────────────────────────────────────────────────────

/** Moves a file to trash (recoverable), via files.update {trashed:true}. */
export async function trashDriveFile(fileId: string, opts?: { token?: string }): Promise<TrashFileResult> {
  const url = `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?supportsAllDrives=true`;
  try {
    const res = await driveFetch(url, {
      method: 'PATCH',
      headers: { ...authHeaders(await token(opts)), 'Content-Type': 'application/json' },
      body: JSON.stringify({ trashed: true }),
    }, 'trashDriveFile');
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`, status: res.status };
    return { ok: true, status: res.status };
  } catch (err) {
    return { ok: false, error: String(err), status: 0 };
  }
}

/**
 * Server-side byte-for-byte copy of `sourceFileId` into `parentFolderId`,
 * stamping `appProperties` in the same request. The bytes never transit the app.
 */
export async function copyDriveFile(
  sourceFileId: string,
  parentFolderId: string,
  name: string,
  appProperties?: Record<string, string>,
  opts?: { token?: string },
): Promise<CopyFileResult> {
  const url = `${DRIVE_API_BASE}/files/${encodeURIComponent(sourceFileId)}/copy?fields=id&supportsAllDrives=true`;
  const body: Record<string, unknown> = { name, parents: [parentFolderId] };
  if (appProperties && Object.keys(appProperties).length > 0) body.appProperties = appProperties;
  try {
    const res = await driveFetch(url, {
      method: 'POST',
      headers: { ...authHeaders(await token(opts)), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, 'copyDriveFile');
    const text = await res.text();
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 300)}`, status: res.status };
    const parsed = JSON.parse(text) as { id?: string };
    if (!parsed.id) return { ok: false, error: `Malformed Drive response: ${text.slice(0, 200)}`, status: res.status };
    return { ok: true, fileId: parsed.id, status: res.status };
  } catch (err) {
    return { ok: false, error: String(err), status: 0 };
  }
}

/** Merges `appProperties` onto a file (Drive merges, does not replace the map). */
export async function setFileAppProperties(
  fileId: string,
  appProperties: Record<string, string>,
  opts?: { token?: string },
): Promise<UpdateFileResult> {
  const url = `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?fields=id&supportsAllDrives=true`;
  try {
    const res = await driveFetch(url, {
      method: 'PATCH',
      headers: { ...authHeaders(await token(opts)), 'Content-Type': 'application/json' },
      body: JSON.stringify({ appProperties }),
    }, 'setFileAppProperties');
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`, status: res.status };
    return { ok: true, status: res.status };
  } catch (err) {
    return { ok: false, error: String(err), status: 0 };
  }
}

/** User-facing Drive folder URL (works for My Drive and Shared Drive folders). */
export function driveFolderUrl(folderId: string): string {
  return `https://drive.google.com/drive/folders/${folderId}`;
}
