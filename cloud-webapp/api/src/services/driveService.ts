/**
 * driveService.ts — read an event's Drive folder (dev plan M1.2).
 *
 * Auth = keyless domain-wide delegation, the verified G1 pattern (runbook
 * §G1): sign a JWT as the DWD-enabled SA (indexer-runtime@) with
 * `sub=<workspace user>`, exchange it for a Drive access token. No SA keys.
 *
 * IAM prerequisite (one-time): the api's runtime SA needs
 * roles/iam.serviceAccountTokenCreator ON indexer-runtime@ so it can call
 * iamcredentials signJwt for it:
 *
 *   gcloud iam service-accounts add-iam-policy-binding \
 *     indexer-runtime@mmr-data-pipeline.iam.gserviceaccount.com \
 *     --member="serviceAccount:api-runtime@mmr-data-pipeline.iam.gserviceaccount.com" \
 *     --role="roles/iam.serviceAccountTokenCreator"
 */

import { randomUUID } from 'node:crypto';

import { GoogleAuth } from 'google-auth-library';
import { env } from '../lib/config.js';

const DRIVE = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** Read-only scope used by the listing/metadata calls (the indexer's scope). */
export const DRIVE_SCOPE_READONLY = 'https://www.googleapis.com/auth/drive.readonly';
/**
 * Read-write scope needed to copy volunteer uploads INTO an event's Drive
 * folder (volunteerUploadService.enqueueStagedBatch). `drive.file` is too
 * narrow — it only grants access to files the app itself created, so it cannot
 * add a file to a pre-existing event folder. With domain-wide delegation
 * (sub=admin@) the full `drive` scope mirrors the read path's domain reach.
 * OPERATOR: this scope must be added to the DWD client's allowed scopes in the
 * Workspace Admin console (same client id) — see UPLOAD_RESUMABLE_NOTES.
 */
export const DRIVE_SCOPE_READWRITE = 'https://www.googleapis.com/auth/drive';

const FOLDER_MIME = 'application/vnd.google-apps.folder';

/**
 * Folders that hold shortcuts / duplicate copies rather than original photos
 * (e.g. the "Photos_zzz" album-copy folders the gas-app special-folders rebuild
 * creates). The Python indexer (indexer/drive.py) never recurses into these, so
 * this listing — and the index-scan fingerprint built from it — must skip them
 * too. Otherwise the fingerprint churns every time those derived folders get
 * rebuilt and the scan re-indexes an unchanged event. Matched case-insensitively
 * on the folder display name; override via SKIP_FOLDER_NAMES (comma-separated),
 * the same env var the indexer reads, so both stay in lockstep.
 */
const SKIP_FOLDER_NAMES = new Set(
  (process.env.SKIP_FOLDER_NAMES ?? 'Photos_zzz')
    .split(',')
    .map((n) => n.trim().toLowerCase())
    .filter((n) => n.length > 0),
);

const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });

export interface DriveImage {
  id: string;
  name: string;
  relPath: string;
  mimeType: string;
  md5Checksum?: string;
  modifiedTime?: string;
  size?: string;
}

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

/**
 * Mint (and cache) a Drive access token via keyless DWD. Tokens are cached per
 * scope so the read path (drive.readonly) and the upload path (drive) don't
 * clobber each other.
 */
export async function getDriveToken(scope: string = DRIVE_SCOPE_READONLY): Promise<string> {
  const hit = tokenCache.get(scope);
  if (hit && Date.now() < hit.expiresAt - 60_000) return hit.token;

  const sa = env.DWD_SA;
  const now = Math.floor(Date.now() / 1000);
  const claims = JSON.stringify({
    iss: sa,
    sub: env.DWD_SUBJECT,
    scope,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  });

  const client = await auth.getClient();
  const signRes = await client.request<{ signedJwt: string }>({
    url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${sa}:signJwt`,
    method: 'POST',
    data: { payload: claims },
  });

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: signRes.data.signedJwt,
  });
  const tokenRes = await fetch(TOKEN_URL, { method: 'POST', body });
  if (!tokenRes.ok) {
    throw new Error(`DWD token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`);
  }
  const json = (await tokenRes.json()) as { access_token: string; expires_in: number };
  const entry = { token: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
  tokenCache.set(scope, entry);
  return entry.token;
}

async function driveGet(url: string, token: string): Promise<Record<string, unknown>> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Drive API ${res.status}: ${await res.text()}`);
  return (await res.json()) as Record<string, unknown>;
}

/**
 * Recursively list image files in a Drive folder.
 * Mirrors indexer/drive.py `list_images` — same fields, same shortcut policy
 * (shortcuts not followed), and the same SKIP_FOLDER_NAMES exclusion so the
 * derived duplicate/album-copy folders are not double-counted. Pass `token`
 * explicitly in tests.
 */
export async function listEventImages(folderId: string, opts?: { token?: string; rel?: string }): Promise<DriveImage[]> {
  const token = opts?.token ?? (await getDriveToken());
  const rel = opts?.rel ?? '';
  const items: DriveImage[] = [];
  let pageToken: string | undefined;

  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed=false`,
      fields: 'nextPageToken,files(id,name,mimeType,md5Checksum,modifiedTime,size)',
      pageSize: '1000',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    });
    if (pageToken) params.set('pageToken', pageToken);

    const page = (await driveGet(`${DRIVE}?${params}`, token)) as {
      nextPageToken?: string;
      files?: Array<Omit<DriveImage, 'relPath'>>;
    };
    for (const f of page.files ?? []) {
      const relPath = `${rel}${f.name}`;
      if (f.mimeType === FOLDER_MIME) {
        if (SKIP_FOLDER_NAMES.has(f.name.trim().toLowerCase())) continue;
        items.push(...(await listEventImages(f.id, { token, rel: `${relPath}/` })));
      } else if (f.mimeType.startsWith('image/')) {
        items.push({ ...f, relPath });
      }
    }
    pageToken = page.nextPageToken;
  } while (pageToken);

  return items;
}

/** Fetch metadata for a single Drive file. */
export async function getFileMetadata(fileId: string, opts?: { token?: string }): Promise<DriveImage> {
  const token = opts?.token ?? (await getDriveToken());
  const params = new URLSearchParams({
    fields: 'id,name,mimeType,md5Checksum,modifiedTime,size',
    supportsAllDrives: 'true',
  });
  const f = (await driveGet(`${DRIVE}/${fileId}?${params}`, token)) as Omit<DriveImage, 'relPath'>;
  return { ...f, relPath: f.name };
}

/**
 * Move a Drive file to Trash (recoverable for ~30 days). Used by the admin
 * photo-delete tool to remove an event's original (photoId === Drive fileId).
 * Trashing, not permanent deletion, so an accidental delete can be restored.
 * Requires a write-scoped token (DRIVE_SCOPE_READWRITE); `supportsAllDrives` so
 * shared-drive originals trash the same as My Drive ones. Pass `token` in tests.
 */
export async function trashFile(fileId: string, opts?: { token?: string }): Promise<void> {
  const token = opts?.token ?? (await getDriveToken(DRIVE_SCOPE_READWRITE));
  const params = new URLSearchParams({ supportsAllDrives: 'true', fields: 'id,trashed' });
  const res = await fetch(`${DRIVE}/${fileId}?${params}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ trashed: true }),
  });
  if (!res.ok) throw new Error(`Drive trash ${res.status}: ${await res.text()}`);
}

/**
 * Restore a trashed Drive file (`trashed:false`). Used by the deleted-files
 * restore path (dev plan G5.1) within the retention window. Requires a
 * write-scoped token; pass `token` in tests.
 */
export async function untrashFile(fileId: string, opts?: { token?: string }): Promise<void> {
  const token = opts?.token ?? (await getDriveToken(DRIVE_SCOPE_READWRITE));
  const params = new URLSearchParams({ supportsAllDrives: 'true', fields: 'id,trashed' });
  const res = await fetch(`${DRIVE}/${fileId}?${params}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ trashed: false }),
  });
  if (!res.ok) throw new Error(`Drive untrash ${res.status}: ${await res.text()}`);
}

/**
 * Permanently delete a Drive file (no trash). Used by the deleted-files purge job
 * (dev plan G5.1) once a soft-deleted file passes its retention window — NOT
 * recoverable. Requires a write-scoped token; pass `token` in tests.
 */
export async function deleteFilePermanently(fileId: string, opts?: { token?: string }): Promise<void> {
  const token = opts?.token ?? (await getDriveToken(DRIVE_SCOPE_READWRITE));
  const params = new URLSearchParams({ supportsAllDrives: 'true' });
  const res = await fetch(`${DRIVE}/${fileId}?${params}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  // 204 No Content on success; 404 means it's already gone (treat as success).
  if (!res.ok && res.status !== 404) throw new Error(`Drive delete ${res.status}: ${await res.text()}`);
}

export interface UploadedDriveFile {
  id: string;
  name: string;
}

/**
 * Create a new file inside a Drive folder from raw bytes (multipart upload).
 * Used by the volunteer-upload handoff to copy a staged original into the
 * event's Drive folder. Requires a write-scoped token (DRIVE_SCOPE_READWRITE);
 * pass `token` explicitly in tests. `supportsAllDrives` so shared-drive folders
 * work the same as My Drive ones.
 */
export async function uploadFileToDrive(
  folderId: string,
  name: string,
  mimeType: string,
  bytes: Uint8Array,
  opts?: { token?: string },
): Promise<UploadedDriveFile> {
  const token = opts?.token ?? (await getDriveToken(DRIVE_SCOPE_READWRITE));
  const boundary = `mmr_${randomUUID()}`;
  const metadata = { name, parents: [folderId] };
  const head =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${mimeType || 'application/octet-stream'}\r\n\r\n`;
  const tail = `\r\n--${boundary}--`;
  const body = Buffer.concat([Buffer.from(head, 'utf8'), Buffer.from(bytes), Buffer.from(tail, 'utf8')]);

  const params = new URLSearchParams({
    uploadType: 'multipart',
    supportsAllDrives: 'true',
    fields: 'id,name',
  });
  const res = await fetch(`${DRIVE_UPLOAD}?${params}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body,
  });
  if (!res.ok) throw new Error(`Drive upload ${res.status}: ${await res.text()}`);
  return (await res.json()) as UploadedDriveFile;
}

/**
 * Find a child folder by exact name under `parentId`, creating it if absent.
 * Used by the volunteer-upload handoff to rebuild the gas-app
 * Event/Club/tag/batch hierarchy (driveService.ts §"Drive layout"): one call
 * per layer. Idempotent — concurrent batches reuse the same club/tag folders.
 * Requires a write-scoped token (DRIVE_SCOPE_READWRITE); `supportsAllDrives`
 * so shared-drive event folders behave like My Drive ones.
 *
 * The Drive `q` filter matches the immediate children of `parentId` only
 * (`'<id>' in parents`), so a same-named folder elsewhere is never reused. A
 * single-quote in the name is escaped per Drive query syntax (`\'`).
 */
export async function getOrCreateSubfolder(
  parentId: string,
  name: string,
  opts?: { token?: string },
): Promise<UploadedDriveFile> {
  const token = opts?.token ?? (await getDriveToken(DRIVE_SCOPE_READWRITE));
  const safe = name.replace(/'/g, "\\'");

  const params = new URLSearchParams({
    q: `'${parentId}' in parents and name='${safe}' and mimeType='${FOLDER_MIME}' and trashed=false`,
    fields: 'files(id,name)',
    pageSize: '1',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
  });
  const found = (await driveGet(`${DRIVE}?${params}`, token)) as { files?: UploadedDriveFile[] };
  const existing = found.files?.[0];
  if (existing) return existing;

  const createParams = new URLSearchParams({ supportsAllDrives: 'true', fields: 'id,name' });
  const res = await fetch(`${DRIVE}?${createParams}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
  });
  if (!res.ok) throw new Error(`Drive folder create ${res.status}: ${await res.text()}`);
  return (await res.json()) as UploadedDriveFile;
}
