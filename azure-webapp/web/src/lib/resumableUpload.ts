/**
 * resumableUpload.ts — browser-side GCS resumable upload with resume.
 *
 * Per file:
 *   1. Reuse a persisted session URI (uploadDb) if the volunteer already started
 *      this exact file; otherwise ask the api to mint one
 *      (POST /api/volunteer/upload/session) and persist it.
 *   2. Query GCS for how many bytes are already committed (handles a resumed
 *      tab or a half-finished previous attempt).
 *   3. PUT the remaining bytes in 8 MiB chunks, reporting progress. A network
 *      error or 5xx is retried with backoff after re-querying the offset, so a
 *      dropped connection never restarts the whole file.
 *
 * GCS resumable protocol notes (must match the bucket CORS — see
 * UPLOAD_RESUMABLE_NOTES): chunk sizes must be a multiple of 256 KiB except the
 * final chunk; an incomplete PUT returns HTTP 308 with a `Range: bytes=0-N`
 * header; the final chunk returns 200/201. The bucket CORS must expose the
 * `Range` header or the browser can't read the committed offset.
 */

import { apiPost } from './api.js';
import { getRecaptchaToken } from './recaptcha.js';
import { getSession, putSession, deleteSession, sessionKey, type StoredSession } from './uploadDb.js';

/** 256 KiB granularity GCS requires; 8 MiB balances throughput vs. resume cost. */
const CHUNK_SIZE = 8 * 1024 * 1024;
const MAX_RETRIES = 5;

export interface UploadResult {
  uploadId: string;
  objectName: string;
  bytes: number;
}

export interface UploadCallbacks {
  /** Bytes committed so far for THIS file (0..file.size). */
  onProgress?: (bytesSent: number) => void;
  /** Fired once when a resumable session is (re)established. */
  onResumed?: (fromByte: number) => void;
  signal?: AbortSignal;
}

interface SessionResponse {
  ok: true;
  uploadId: string;
  sessionUri: string;
  objectName: string;
  batchId: string;
}

class AbortError extends Error {
  constructor() {
    super('Upload aborted');
    this.name = 'AbortError';
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Get a persisted session for this file or mint a fresh one via the api. */
async function ensureSession(
  token: string,
  batchId: string,
  file: File,
  mimeType: string,
  photographerName: string,
): Promise<StoredSession> {
  const key = sessionKey(token, file);
  const existing = await getSession(key);
  if (existing && existing.total === file.size) return existing;

  // Acquire a reCAPTCHA token for this action (undefined when not configured —
  // the server's gate no-ops in that case). Sent as a header so it never has to
  // pass the request-body schema.
  const recaptchaToken = await getRecaptchaToken('volunteer_upload');

  const res = await apiPost<SessionResponse>(
    '/api/volunteer/upload/session',
    {
      token,
      batchId,
      fileName: file.name,
      mimeType,
      size: file.size,
      photographerName,
    },
    recaptchaToken ? { headers: { 'X-Recaptcha-Token': recaptchaToken } } : undefined,
  );
  const rec: StoredSession = {
    key,
    uploadId: res.uploadId,
    objectName: res.objectName,
    sessionUri: res.sessionUri,
    batchId: res.batchId,
    total: file.size,
    createdAt: Date.now(),
  };
  await putSession(rec);
  return rec;
}

/** Parse the committed byte count from a GCS `Range: bytes=0-N` header. */
export function committedFromRange(rangeHeader: string | null): number {
  if (!rangeHeader) return 0;
  const m = /bytes=0-(\d+)/.exec(rangeHeader);
  return m ? Number(m[1]) + 1 : 0;
}

/** Exponential backoff (capped at 15 s) for retry attempt N (1-based). */
export function backoffMs(attempt: number): number {
  return Math.min(1000 * 2 ** (attempt - 1), 15_000);
}

/**
 * Ask GCS how many bytes of `total` are already committed for this session.
 * Returns the byte offset to resume from, or -1 if the upload is already
 * complete (GCS answers 200/201 to the status probe).
 */
export async function queryOffset(sessionUri: string, total: number): Promise<number> {
  const res = await fetch(sessionUri, {
    method: 'PUT',
    headers: { 'Content-Range': `bytes */${total}` },
  });
  if (res.status === 200 || res.status === 201) return -1;
  if (res.status === 308) return committedFromRange(res.headers.get('Range'));
  throw new Error(`Resume query failed: HTTP ${res.status}`);
}

/** PUT one chunk via XHR (for upload progress). Resolves with the new committed
 *  offset, or -1 when the whole object is finalized (200/201). */
function putChunk(
  sessionUri: string,
  file: File,
  start: number,
  total: number,
  onProgress: (sent: number) => void,
  signal?: AbortSignal,
): Promise<number> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AbortError());
    const end = Math.min(start + CHUNK_SIZE, total);
    const blob = file.slice(start, end);

    const xhr = new XMLHttpRequest();
    xhr.open('PUT', sessionUri);
    xhr.setRequestHeader('Content-Range', `bytes ${start}-${end - 1}/${total}`);

    const onAbort = (): void => xhr.abort();
    signal?.addEventListener('abort', onAbort);
    const cleanup = (): void => signal?.removeEventListener('abort', onAbort);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(start + e.loaded);
    };
    xhr.onload = () => {
      cleanup();
      if (xhr.status === 200 || xhr.status === 201) {
        resolve(-1);
      } else if (xhr.status === 308) {
        resolve(committedFromRange(xhr.getResponseHeader('Range')) || end);
      } else {
        reject(new Error(`Chunk PUT failed: HTTP ${xhr.status}`));
      }
    };
    xhr.onerror = () => {
      cleanup();
      reject(new Error('Network error during chunk upload'));
    };
    xhr.onabort = () => {
      cleanup();
      reject(new AbortError());
    };
    xhr.send(blob);
  });
}

/**
 * Upload one file with full resume support. Returns the staged object name +
 * committed byte count for the /complete call. Throws AbortError if the caller
 * aborts via `signal`.
 */
export async function uploadFileResumable(
  token: string,
  batchId: string,
  file: File,
  mimeType: string,
  cb: UploadCallbacks = {},
  photographerName = '',
): Promise<UploadResult> {
  const session = await ensureSession(token, batchId, file, mimeType, photographerName);
  const { sessionUri, total } = { sessionUri: session.sessionUri, total: session.total };

  // Where to resume from (handles a reopened tab / prior partial attempt).
  let offset = await queryOffset(sessionUri, total);
  if (offset === -1) {
    await deleteSession(session.key);
    cb.onProgress?.(total);
    return { uploadId: session.uploadId, objectName: session.objectName, bytes: total };
  }
  if (offset > 0) cb.onResumed?.(offset);

  let attempt = 0;
  while (offset < total) {
    if (cb.signal?.aborted) throw new AbortError();
    try {
      const next = await putChunk(sessionUri, file, offset, total, (sent) => cb.onProgress?.(sent), cb.signal);
      if (next === -1) {
        offset = total;
        break;
      }
      offset = next;
      attempt = 0; // progress made → reset backoff
    } catch (err) {
      if (err instanceof AbortError) throw err;
      if (++attempt > MAX_RETRIES) throw err;
      await sleep(backoffMs(attempt));
      // Re-sync the offset from GCS before retrying (it may have committed
      // part of the failed chunk).
      const q = await queryOffset(sessionUri, total);
      if (q === -1) {
        offset = total;
        break;
      }
      offset = q;
    }
  }

  await deleteSession(session.key);
  cb.onProgress?.(total);
  return { uploadId: session.uploadId, objectName: session.objectName, bytes: total };
}

export { AbortError };
