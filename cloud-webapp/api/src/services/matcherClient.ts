/**
 * matcherClient.ts — call the private matcher Cloud Run service (M2.2).
 *
 * Auth: the matcher deploys without --allow-unauthenticated; we mint an IAM
 * ID token for the matcher's URL (audience) via google-auth-library, which
 * on Cloud Run uses the metadata server — keyless, same pattern as
 * cloud-run/main.py's callers. Locally, ADC must be able to mint ID tokens
 * (`gcloud auth application-default login` works for user creds via the
 * impersonation flow, or run the matcher locally with MATCHER_URL set to
 * http://localhost:8081 — http URLs skip token minting).
 */

import { GoogleAuth } from 'google-auth-library';
import { env } from '../lib/config.js';

const auth = new GoogleAuth();

export interface MatcherSearchHit {
  photoId: string;
  score: number;
  faceScore: number | null;
  personScore: number | null;
}

export type MatcherSearchResult =
  | {
      ok: true;
      eventId: string;
      mode: 'fused' | 'face' | 'person';
      modelVersion?: string;
      normalized?: boolean;
      results: MatcherSearchHit[];
    }
  | { ok: false; status: number; error: string; message: string };

/** One reference selfie for the query. Passing more than one builds a
 *  centroid query on the matcher (§1.1) — averages out any single shot's
 *  pose/blur. */
export interface MatcherReferenceImage {
  image: Buffer;
  filename: string;
  contentType: string;
}

async function authHeaders(url: string): Promise<Record<string, string>> {
  if (url.startsWith('http://')) return {}; // local dev matcher
  const client = await auth.getIdTokenClient(env.MATCHER_URL);
  const headers = await client.getRequestHeaders(url);
  return Object.fromEntries(Object.entries(headers));
}

/**
 * POST /search on the matcher: reference image + event → fused ranking.
 * Network/5xx errors are surfaced as { ok: false } with the upstream error
 * string preserved (lesson from CODE_QUALITY_ASSESSMENT §1.4 — don't
 * collapse retriable and fatal errors into one bucket).
 */
export async function matcherSearch(opts: {
  /** Single reference selfie. Mutually complementary with `images` — both are
   *  accepted and combined so existing single-image callers need no change. */
  image?: Buffer;
  filename?: string;
  contentType?: string;
  /** Multiple reference selfies → centroid query (§1.1). */
  images?: MatcherReferenceImage[];
  eventId: string;
  topK?: number;
  mode?: 'fused' | 'face' | 'person';
  /** photoIds the user confirmed as matches; folded back into the query on the
   *  matcher (pseudo-relevance feedback, §1.2). */
  prfPhotoIds?: string[];
  /** Apply T-norm cohort score normalization (§1.3). */
  normalize?: boolean;
}): Promise<MatcherSearchResult> {
  if (!env.MATCHER_URL) {
    return {
      ok: false,
      status: 503,
      error: 'matcher_unconfigured',
      message: 'MATCHER_URL is not set — deploy the matcher and redeploy the api with its URL',
    };
  }

  const references: MatcherReferenceImage[] = [
    ...(opts.image !== undefined
      ? [{ image: opts.image, filename: opts.filename ?? 'reference.jpg', contentType: opts.contentType ?? 'application/octet-stream' }]
      : []),
    ...(opts.images ?? []),
  ];
  if (references.length === 0) {
    return { ok: false, status: 400, error: 'missing_file', message: 'no reference image provided' };
  }

  const url = `${env.MATCHER_URL.replace(/\/$/, '')}/search`;
  const form = new FormData();
  for (const ref of references) {
    form.append('file', new Blob([new Uint8Array(ref.image)], { type: ref.contentType }), ref.filename);
  }
  form.set('event_id', opts.eventId);
  if (opts.topK !== undefined) form.set('top_k', String(opts.topK));
  if (opts.mode) form.set('mode', opts.mode);
  if (opts.prfPhotoIds?.length) form.set('prf_photo_ids', opts.prfPhotoIds.join(','));
  if (opts.normalize) form.set('normalize', '1');

  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers: await authHeaders(url), body: form });
  } catch (err) {
    return {
      ok: false,
      status: 502,
      error: 'matcher_unreachable',
      message: err instanceof Error ? err.message : String(err),
    };
  }

  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error: typeof body.error === 'string' ? body.error : 'matcher_error',
      message: typeof body.detail === 'string' ? body.detail : `matcher returned ${res.status}`,
    };
  }

  return {
    ok: true,
    eventId: String(body.eventId ?? opts.eventId),
    mode: (body.mode as 'fused' | 'face' | 'person') ?? 'fused',
    ...(typeof body.modelVersion === 'string' ? { modelVersion: body.modelVersion } : {}),
    ...(typeof body.normalized === 'boolean' ? { normalized: body.normalized } : {}),
    results: (body.results as MatcherSearchHit[]) ?? [],
  };
}
