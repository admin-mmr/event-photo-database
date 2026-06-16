/**
 * Tiny fetch wrapper. Same-origin in production (Firebase Hosting rewrites
 * /api/** to Cloud Run); proxied by Vite in dev.
 *
 * Attaches `Authorization: Bearer <Firebase ID token>` when signed in.
 */

import { idToken } from './firebase.js';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function authHeader(): Promise<Record<string, string>> {
  try {
    const token = await idToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

async function parseError(res: Response, fallback: string): Promise<ApiError> {
  const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
  return new ApiError(res.status, body.error ?? 'http_error', body.message ?? fallback);
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(path, {
    method: 'GET',
    headers: { Accept: 'application/json', ...(await authHeader()) },
  });
  if (!res.ok) throw await parseError(res, `GET ${path} failed: HTTP ${res.status}`);
  return (await res.json()) as T;
}

export async function apiPost<T, B = unknown>(path: string, body: B): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(await authHeader()),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await parseError(res, `POST ${path} failed: HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** Multipart POST (Find Me reference upload). */
export async function apiUpload<T>(path: string, form: FormData): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { Accept: 'application/json', ...(await authHeader()) },
    body: form,
  });
  if (!res.ok) throw await parseError(res, `POST ${path} failed: HTTP ${res.status}`);
  return (await res.json()) as T;
}

/**
 * POST a JSON body and return the binary response as a Blob (B1 ZIP). A plain
 * <a download> can't carry the Firebase bearer header, so we fetch the bytes
 * ourselves. The caller decides whether to download or share it (M4.3). The
 * blob lives in browser memory — the server caps the photo count to bound it.
 */
export async function apiFetchBlob<B = unknown>(path: string, body: B): Promise<Blob> {
  const res = await fetch(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/zip, application/octet-stream',
      ...(await authHeader()),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await parseError(res, `POST ${path} failed: HTTP ${res.status}`);
  return res.blob();
}

/** POST a JSON body and save the binary response as a file (B1 ZIP download). */
export async function apiDownloadFile<B = unknown>(
  path: string,
  body: B,
  filename: string,
): Promise<void> {
  const blob = await apiFetchBlob(path, body);
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Defer revoke so the download has a chance to start across browsers.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}
