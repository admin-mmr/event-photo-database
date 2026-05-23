/**
 * Tiny fetch wrapper. Same-origin in production (Firebase Hosting rewrites
 * /api/** to Cloud Run); proxied by Vite in dev.
 *
 * When auth is wired in, this is the place to attach the
 * `Authorization: Bearer <Firebase ID token>` header.
 */
export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(path, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`GET ${path} failed: HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function apiPost<T, B = unknown>(path: string, body: B): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`POST ${path} failed: HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}
