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
  const url = `${DRIVE_API_BASE}/files?fields=id`;
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
      'fields=nextPageToken,files(id,name,shortcutDetails/targetId)',
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
        shortcutDetails?: { targetId?: string };
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
      if (id && targetId) {
        out.push({ id, name, targetId });
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
