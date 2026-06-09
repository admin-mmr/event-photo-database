/**
 * driveShortcutClient.ts — Drive REST API helpers for shortcut files.
 *
 * Why a REST client when we already use DriveApp?
 * ──────────────────────────────────────────────
 * The advanced "Drive" service is not enabled in this script's
 * appsscript.json `dependencies`, and the bare `DriveApp` API does not expose
 * a way to create native Google Drive shortcut files. Native shortcuts
 * (mimeType `application/vnd.google-apps.shortcut`) point to a target file by
 * ID and inherit the target's preview/permissions; trash/restore on the
 * target is reflected automatically. They are the most user-friendly option
 * for the consolidated Photos_NNN buckets and per-(event, club, tag) Videos
 * folder.
 *
 * To create them without enabling the advanced Drive service, this module
 * calls the Drive v3 REST API directly via UrlFetchApp using the script's
 * OAuth token — the same pattern photosApiClient.ts uses for the Google
 * Photos Library API.
 *
 * The script already requests the broad `https://www.googleapis.com/auth/drive`
 * scope (see appsscript.json), which covers files.create + files.list with
 * `q` queries against folders the user owns or can edit.
 *
 * No sheet I/O happens here — every function is pure HTTP / pure computation.
 */

/* global ScriptApp, UrlFetchApp, Logger */

// ─── Constants ────────────────────────────────────────────────────────────────

export const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';

/** MIME type Drive uses for shortcut files. */
export const DRIVE_SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';

/**
 * appProperties key stamped on every real file we materialize into a
 * consolidated folder (e.g. a Photos_NNN bucket). Its value is the Drive ID of
 * the ORIGINAL source photo the copy was made from.
 *
 * This is the copy-world analogue of a shortcut's `shortcutDetails.targetId`:
 * it lets the rebuild dedupe (never copy the same source twice) and lets the
 * orphan sweep retire a copy when its source is deleted. appProperties are
 * private to this app (invisible to the end user, not shown in the Drive UI),
 * so they never clutter the photo's metadata.
 */
export const SOURCE_PHOTO_ID_PROPERTY = 'sourcePhotoId';

/** Default page size for files.list paging — Drive's max is 1000. */
const LIST_PAGE_SIZE = 1000;

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Minimal shape of a shortcut entry returned from `files.list` when we
 * include the `shortcutDetails` field. We only use targetId for dedupe so
 * the rest of the API response is intentionally ignored.
 */
export interface ShortcutEntry {
  /** Drive file ID of the shortcut itself. */
  id: string;
  /** User-visible name of the shortcut. */
  name: string;
  /** Drive ID of the file the shortcut points to. */
  targetId: string;
  /**
   * MIME type of the target file, as reported by Drive in
   * `shortcutDetails.targetMimeType`. Lets callers decide copy-vs-convert
   * without a separate metadata fetch. Optional: '' or undefined when Drive
   * did not populate it (callers fall back to a metadata fetch).
   */
  targetMimeType?: string;
}

/** Result envelope for shortcut creation. */
export interface CreateShortcutResult {
  ok: boolean;
  /** Drive file ID of the new shortcut, populated when ok=true. */
  shortcutId?: string;
  /** Error description, populated when ok=false. */
  error?: string;
  /** HTTP status from the Drive API; 0 if the fetch itself threw. */
  status: number;
}

/**
 * File metadata returned by listFilesInFolder. Drive's `size` and
 * `md5Checksum` fields are only populated for binary content (which covers
 * all uploaded photos/videos); Google-native files report sizeBytes=0 and
 * md5Checksum='' and are not interesting to the duplicate scanner anyway.
 */
export interface DriveFileMeta {
  /** Drive file ID. */
  id: string;
  /** User-visible filename. */
  name: string;
  /** MIME type as Drive reports it. */
  mimeType: string;
  /** Byte size; 0 when Drive omits the field. */
  sizeBytes: number;
  /** Content MD5 hex digest; '' when Drive omits the field. */
  md5Checksum: string;
  /** RFC 3339 creation timestamp; '' when omitted. */
  createdTime: string;
}

/** Result envelope for a trash-file call. */
export interface TrashFileResult {
  ok: boolean;
  error?: string;
  /** HTTP status from the Drive API; 0 if the fetch itself threw. */
  status: number;
}

/** Result envelope for a file-copy call. */
export interface CopyFileResult {
  ok: boolean;
  /** Drive file ID of the new copy, populated when ok=true. */
  fileId?: string;
  /** Error description, populated when ok=false. */
  error?: string;
  /** HTTP status from the Drive API; 0 if the fetch itself threw. */
  status: number;
}

/** Result envelope for an appProperties patch. */
export interface UpdateFileResult {
  ok: boolean;
  error?: string;
  /** HTTP status from the Drive API; 0 if the fetch itself threw. */
  status: number;
}

/**
 * A real (non-shortcut) file we materialized into a consolidated folder,
 * tagged with the source photo it was derived from. Returned by
 * listManagedCopiesInFolder for dedupe and orphan-sweep bookkeeping.
 */
export interface ManagedCopyEntry {
  /** Drive file ID of the copy itself. */
  id: string;
  /** User-visible filename of the copy (e.g. "IMG_0042.jpg"). */
  name: string;
  /** Drive ID of the ORIGINAL source photo (from appProperties.sourcePhotoId). */
  sourcePhotoId: string;
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

/**
 * Returns the current OAuth bearer token. Mirrors photosApiClient.getAuthToken
 * so both modules can be mocked the same way in tests.
 */
export function getDriveAuthToken(): string {
  return ScriptApp.getOAuthToken();
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

/**
 * Creates a Drive shortcut file inside `parentFolderId` that points to
 * `targetFileId`. Uses the v3 `files.create` endpoint with the special
 * shortcut MIME type and `shortcutDetails.targetId`.
 *
 * On success returns `ok: true` plus the new shortcut's Drive file ID.
 *
 * @param parentFolderId  Drive ID of the folder that will contain the shortcut
 * @param targetFileId    Drive ID of the file the shortcut should point to
 * @param shortcutName    Filename to give the shortcut (typically the target's name)
 */
export function createDriveShortcut(
  parentFolderId: string,
  targetFileId: string,
  shortcutName: string
): CreateShortcutResult {
  // supportsAllDrives=true is required when the target file or destination
  // folder lives in a Shared Drive. Without it the REST API returns 404
  // even though DriveApp (used by walkMediaFiles) found the file fine.
  const url = `${DRIVE_API_BASE}/files?fields=id&supportsAllDrives=true`;
  const body = {
    name: shortcutName,
    mimeType: DRIVE_SHORTCUT_MIME,
    parents: [parentFolderId],
    shortcutDetails: { targetId: targetFileId },
  };

  try {
    const response = UrlFetchApp.fetch(url, {
      method: 'post',
      headers: {
        Authorization: `Bearer ${getDriveAuthToken()}`,
        'Content-Type': 'application/json',
      },
      payload: JSON.stringify(body),
      muteHttpExceptions: true,
    });

    const code = response.getResponseCode();
    const text = response.getContentText();
    if (code < 200 || code >= 300) {
      return {
        ok: false,
        error: `HTTP ${code}: ${text.slice(0, 300)}`,
        status: code,
      };
    }
    const parsed = JSON.parse(text) as { id?: string };
    if (!parsed.id) {
      return {
        ok: false,
        error: `Malformed Drive response (no id field): ${text.slice(0, 200)}`,
        status: code,
      };
    }
    return { ok: true, shortcutId: parsed.id, status: code };
  } catch (err) {
    return { ok: false, error: String(err), status: 0 };
  }
}

/**
 * Lists every shortcut file directly inside `parentFolderId` (non-recursive)
 * and returns `{ id, name, targetId }` for each. Pages through all results
 * automatically; the underlying `files.list` endpoint caps each page at 1000.
 *
 * Used by specialFoldersService to dedupe — we never want two shortcuts in
 * the same Photos_NNN bucket pointing to the same Drive file.
 */
export function listShortcutsInFolder(parentFolderId: string): ShortcutEntry[] {
  const out: ShortcutEntry[] = [];
  let pageToken: string | null = null;

  // Quote the folder ID and shortcut MIME literal so the q-string is well-formed.
  const q =
    `'${parentFolderId}' in parents and ` +
    `mimeType='${DRIVE_SHORTCUT_MIME}' and ` +
    `trashed=false`;

  do {
    const params: string[] = [
      `q=${encodeURIComponent(q)}`,
      'fields=nextPageToken,files(id,name,shortcutDetails/targetId,shortcutDetails/targetMimeType)',
      `pageSize=${LIST_PAGE_SIZE}`,
      'supportsAllDrives=true',
      'includeItemsFromAllDrives=true',
    ];
    if (pageToken) params.push(`pageToken=${encodeURIComponent(pageToken)}`);

    const url = `${DRIVE_API_BASE}/files?${params.join('&')}`;

    let parsed: {
      nextPageToken?: string;
      files?: Array<{
        id?: string;
        name?: string;
        shortcutDetails?: { targetId?: string; targetMimeType?: string };
      }>;
    };
    try {
      const response = UrlFetchApp.fetch(url, {
        method: 'get',
        headers: { Authorization: `Bearer ${getDriveAuthToken()}` },
        muteHttpExceptions: true,
      });

      const code = response.getResponseCode();
      const text = response.getContentText();
      if (code < 200 || code >= 300) {
        Logger.log(
          `[driveShortcutClient.listShortcutsInFolder] HTTP ${code} for folder ${parentFolderId}: ${text.slice(0, 200)}`
        );
        return out; // partial page accumulation only — better than throwing
      }
      parsed = JSON.parse(text);
    } catch (err) {
      Logger.log(
        `[driveShortcutClient.listShortcutsInFolder] threw for folder ${parentFolderId}: ${String(err)}`
      );
      return out;
    }

    for (const f of parsed.files ?? []) {
      const id = String(f.id ?? '').trim();
      const name = String(f.name ?? '').trim();
      const targetId = String(f.shortcutDetails?.targetId ?? '').trim();
      const targetMimeType = String(f.shortcutDetails?.targetMimeType ?? '').trim();
      if (id && targetId) {
        out.push({ id, name, targetId, targetMimeType });
      }
    }

    pageToken = parsed.nextPageToken ?? null;
  } while (pageToken);

  return out;
}

/**
 * Lists every NON-shortcut, NON-folder file directly inside `parentFolderId`
 * (non-recursive) with the metadata the duplicate scanner needs: byte size,
 * MD5 content checksum and creation time. Pages through all results.
 *
 * Unlike DriveApp, the v3 REST API exposes `md5Checksum`, which lets the
 * duplicate scanner match binary-identical files regardless of filename.
 *
 * Returns whatever pages were fetched successfully — on an HTTP error the
 * partial accumulation is returned and the error is logged, mirroring
 * listShortcutsInFolder's degrade-gracefully contract.
 */
export function listFilesInFolder(parentFolderId: string): DriveFileMeta[] {
  const out: DriveFileMeta[] = [];
  let pageToken: string | null = null;

  const q =
    `'${parentFolderId}' in parents and ` +
    `mimeType!='${DRIVE_SHORTCUT_MIME}' and ` +
    `mimeType!='application/vnd.google-apps.folder' and ` +
    `trashed=false`;

  do {
    const params: string[] = [
      `q=${encodeURIComponent(q)}`,
      'fields=nextPageToken,files(id,name,mimeType,size,md5Checksum,createdTime)',
      `pageSize=${LIST_PAGE_SIZE}`,
      'supportsAllDrives=true',
      'includeItemsFromAllDrives=true',
    ];
    if (pageToken) params.push(`pageToken=${encodeURIComponent(pageToken)}`);

    const url = `${DRIVE_API_BASE}/files?${params.join('&')}`;

    let parsed: {
      nextPageToken?: string;
      files?: Array<{
        id?: string;
        name?: string;
        mimeType?: string;
        size?: string | number;
        md5Checksum?: string;
        createdTime?: string;
      }>;
    };
    try {
      const response = UrlFetchApp.fetch(url, {
        method: 'get',
        headers: { Authorization: `Bearer ${getDriveAuthToken()}` },
        muteHttpExceptions: true,
      });

      const code = response.getResponseCode();
      const text = response.getContentText();
      if (code < 200 || code >= 300) {
        Logger.log(
          `[driveShortcutClient.listFilesInFolder] HTTP ${code} for folder ${parentFolderId}: ${text.slice(0, 200)}`
        );
        return out;
      }
      parsed = JSON.parse(text);
    } catch (err) {
      Logger.log(
        `[driveShortcutClient.listFilesInFolder] threw for folder ${parentFolderId}: ${String(err)}`
      );
      return out;
    }

    for (const f of parsed.files ?? []) {
      const id = String(f.id ?? '').trim();
      if (!id) continue;
      const size = Number(f.size ?? 0);
      out.push({
        id,
        name: String(f.name ?? '').trim(),
        mimeType: String(f.mimeType ?? '').trim(),
        sizeBytes: Number.isFinite(size) && size > 0 ? size : 0,
        md5Checksum: String(f.md5Checksum ?? '').trim(),
        createdTime: String(f.createdTime ?? '').trim(),
      });
    }

    pageToken = parsed.nextPageToken ?? null;
  } while (pageToken);

  return out;
}

/** Minimal file metadata fetched by getDriveFileBasics. */
export interface DriveFileBasics {
  id: string;
  name: string;
  mimeType: string;
}

/**
 * Result of a single-file metadata lookup. Distinguishes a definitive
 * "gone" (HTTP 404) from an ambiguous transient error, so callers can safely
 * decide whether to treat a missing file as dangling (trash it) versus
 * something to retry later.
 */
export type DriveFileLookup =
  | { found: true; file: DriveFileBasics }
  | { found: false; gone: boolean };

/**
 * Fetches id/name/mimeType for a single Drive file via `files.get`.
 *
 * Returns `{ found: true, file }` on success, `{ found: false, gone: true }`
 * when Drive returns 404 (the file no longer exists), and
 * `{ found: false, gone: false }` for any other (transient/ambiguous) failure.
 *
 * Used as a cheap fallback when a shortcut's cached `targetMimeType` is missing,
 * and to confirm a materialization failure is due to a deleted target before
 * trashing the shortcut as dangling.
 */
export function getDriveFileBasics(fileId: string): DriveFileLookup {
  const url = `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType&supportsAllDrives=true`;
  try {
    const response = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: { Authorization: `Bearer ${getDriveAuthToken()}` },
      muteHttpExceptions: true,
    });
    const code = response.getResponseCode();
    if (code === 404) return { found: false, gone: true };
    if (code < 200 || code >= 300) {
      Logger.log(
        `[driveShortcutClient.getDriveFileBasics] HTTP ${code} for file ${fileId}: ${response.getContentText().slice(0, 200)}`
      );
      return { found: false, gone: false };
    }
    const parsed = JSON.parse(response.getContentText()) as {
      id?: string;
      name?: string;
      mimeType?: string;
    };
    return {
      found: true,
      file: {
        id: String(parsed.id ?? fileId).trim(),
        name: String(parsed.name ?? '').trim(),
        mimeType: String(parsed.mimeType ?? '').trim(),
      },
    };
  } catch (err) {
    Logger.log(`[driveShortcutClient.getDriveFileBasics] threw for file ${fileId}: ${String(err)}`);
    return { found: false, gone: false };
  }
}

/**
 * Moves a Drive file to trash via `files.update {trashed: true}`.
 *
 * Used by the orphan-shortcut sweep to retire shortcut files whose targets
 * were soft-deleted. We trash (not hard-delete) so even a mistaken sweep is
 * recoverable from the Drive trash for 30 days.
 */
export function trashDriveFile(fileId: string): TrashFileResult {
  const url = `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?supportsAllDrives=true`;
  try {
    const response = UrlFetchApp.fetch(url, {
      method: 'patch',
      headers: {
        Authorization: `Bearer ${getDriveAuthToken()}`,
        'Content-Type': 'application/json',
      },
      payload: JSON.stringify({ trashed: true }),
      muteHttpExceptions: true,
    });
    const code = response.getResponseCode();
    if (code < 200 || code >= 300) {
      return {
        ok: false,
        error: `HTTP ${code}: ${response.getContentText().slice(0, 300)}`,
        status: code,
      };
    }
    return { ok: true, status: code };
  } catch (err) {
    return { ok: false, error: String(err), status: 0 };
  }
}

/**
 * Server-side copies a Drive file into `parentFolderId` via the v3
 * `files.copy` endpoint, stamping `appProperties` on the new copy in the same
 * request. Used to materialize a JPEG source directly into a Photos_NNN bucket
 * (no re-encode) while tagging it with its source photo ID for dedupe.
 *
 * `files.copy` performs a true byte-for-byte server-side copy — the bytes
 * never transit Apps Script — so it is fast and does not count against the
 * UrlFetch response-size limits.
 *
 * @param sourceFileId   Drive ID of the file to copy
 * @param parentFolderId Drive ID of the destination folder
 * @param name           Filename for the copy
 * @param appProperties  Private app metadata to attach (e.g. { sourcePhotoId })
 */
export function copyDriveFile(
  sourceFileId: string,
  parentFolderId: string,
  name: string,
  appProperties?: Record<string, string>
): CopyFileResult {
  const url = `${DRIVE_API_BASE}/files/${encodeURIComponent(sourceFileId)}/copy?fields=id&supportsAllDrives=true`;
  const body: Record<string, unknown> = {
    name,
    parents: [parentFolderId],
  };
  if (appProperties && Object.keys(appProperties).length > 0) {
    body.appProperties = appProperties;
  }

  try {
    const response = UrlFetchApp.fetch(url, {
      method: 'post',
      headers: {
        Authorization: `Bearer ${getDriveAuthToken()}`,
        'Content-Type': 'application/json',
      },
      payload: JSON.stringify(body),
      muteHttpExceptions: true,
    });

    const code = response.getResponseCode();
    const text = response.getContentText();
    if (code < 200 || code >= 300) {
      return { ok: false, error: `HTTP ${code}: ${text.slice(0, 300)}`, status: code };
    }
    const parsed = JSON.parse(text) as { id?: string };
    if (!parsed.id) {
      return {
        ok: false,
        error: `Malformed Drive response (no id field): ${text.slice(0, 200)}`,
        status: code,
      };
    }
    return { ok: true, fileId: parsed.id, status: code };
  } catch (err) {
    return { ok: false, error: String(err), status: 0 };
  }
}

/**
 * Patches a Drive file's private `appProperties` via `files.update`.
 *
 * Needed because the Cloud Run convert service uploads the JPG it produces
 * without our `sourcePhotoId` tag; we stamp it here right after conversion so
 * the file participates in dedupe and orphan-sweep exactly like a copied JPEG.
 *
 * Drive MERGES the supplied appProperties with any existing ones (it does not
 * replace the whole map), so this is safe to call on a file that already has
 * other private properties.
 */
export function setFileAppProperties(
  fileId: string,
  appProperties: Record<string, string>
): UpdateFileResult {
  const url = `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?fields=id&supportsAllDrives=true`;
  try {
    const response = UrlFetchApp.fetch(url, {
      method: 'patch',
      headers: {
        Authorization: `Bearer ${getDriveAuthToken()}`,
        'Content-Type': 'application/json',
      },
      payload: JSON.stringify({ appProperties }),
      muteHttpExceptions: true,
    });
    const code = response.getResponseCode();
    if (code < 200 || code >= 300) {
      return {
        ok: false,
        error: `HTTP ${code}: ${response.getContentText().slice(0, 300)}`,
        status: code,
      };
    }
    return { ok: true, status: code };
  } catch (err) {
    return { ok: false, error: String(err), status: 0 };
  }
}

/**
 * Lists every real (non-shortcut, non-folder) file directly inside
 * `parentFolderId` that we materialized — i.e. that carries a
 * `sourcePhotoId` appProperty — and returns `{ id, name, sourcePhotoId }`.
 * Pages through all results.
 *
 * Files without the appProperty (e.g. something a human manually dropped into
 * the folder) are skipped, so the rebuild and orphan sweep only ever act on
 * copies they created themselves. Degrades gracefully on HTTP errors like the
 * other list helpers.
 */
export function listManagedCopiesInFolder(parentFolderId: string): ManagedCopyEntry[] {
  const out: ManagedCopyEntry[] = [];
  let pageToken: string | null = null;

  const q =
    `'${parentFolderId}' in parents and ` +
    `mimeType!='${DRIVE_SHORTCUT_MIME}' and ` +
    `mimeType!='application/vnd.google-apps.folder' and ` +
    `trashed=false`;

  do {
    const params: string[] = [
      `q=${encodeURIComponent(q)}`,
      'fields=nextPageToken,files(id,name,appProperties)',
      `pageSize=${LIST_PAGE_SIZE}`,
      'supportsAllDrives=true',
      'includeItemsFromAllDrives=true',
    ];
    if (pageToken) params.push(`pageToken=${encodeURIComponent(pageToken)}`);

    const url = `${DRIVE_API_BASE}/files?${params.join('&')}`;

    let parsed: {
      nextPageToken?: string;
      files?: Array<{
        id?: string;
        name?: string;
        appProperties?: Record<string, string>;
      }>;
    };
    try {
      const response = UrlFetchApp.fetch(url, {
        method: 'get',
        headers: { Authorization: `Bearer ${getDriveAuthToken()}` },
        muteHttpExceptions: true,
      });

      const code = response.getResponseCode();
      const text = response.getContentText();
      if (code < 200 || code >= 300) {
        Logger.log(
          `[driveShortcutClient.listManagedCopiesInFolder] HTTP ${code} for folder ${parentFolderId}: ${text.slice(0, 200)}`
        );
        return out;
      }
      parsed = JSON.parse(text);
    } catch (err) {
      Logger.log(
        `[driveShortcutClient.listManagedCopiesInFolder] threw for folder ${parentFolderId}: ${String(err)}`
      );
      return out;
    }

    for (const f of parsed.files ?? []) {
      const id = String(f.id ?? '').trim();
      const sourcePhotoId = String(f.appProperties?.[SOURCE_PHOTO_ID_PROPERTY] ?? '').trim();
      if (id && sourcePhotoId) {
        out.push({ id, name: String(f.name ?? '').trim(), sourcePhotoId });
      }
    }

    pageToken = parsed.nextPageToken ?? null;
  } while (pageToken);

  return out;
}

/**
 * Builds the user-facing Drive folder URL for a folder ID.
 * Drive accepts the `/drive/folders/<id>` path for both "My Drive" and
 * Shared Drive folders, so this URL works for any folder we'd reasonably
 * record in the Special_Folders sheet.
 */
export function driveFolderUrl(folderId: string): string {
  return `https://drive.google.com/drive/folders/${folderId}`;
}
