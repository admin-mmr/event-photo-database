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
import {
  ReferenceFacesSchema,
  SelfieFaceReasonSchema,
  type ReferenceFaces,
  type SelfieFaceReason,
} from '@cloud-webapp/shared';

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
      /** Per-reference-selfie face census (see shared ReferenceFaces). Absent
       *  when the deployed matcher predates the field. */
      referenceFaces?: ReferenceFaces[];
      results: MatcherSearchHit[];
    }
  | {
      ok: false;
      status: number;
      error: string;
      message: string;
      /** On a `no_usable_face` 422: why the faces were rejected, so the api can
       *  tell the searcher what to fix rather than "no clear face". */
      faceReasons?: SelfieFaceReason[];
    };

/**
 * Defensively coerce the matcher's `referenceFaces` array. It arrives as
 * untyped JSON from another service, and a shape mismatch must degrade to
 * "no census" rather than throwing mid-search — the ranking is the payload
 * that matters, the census is only a UI warning.
 */
function parseReferenceFaces(raw: unknown): ReferenceFaces[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: ReferenceFaces[] = [];
  for (const item of raw) {
    const parsed = ReferenceFacesSchema.safeParse(item);
    if (!parsed.success) return undefined;
    out.push(parsed.data);
  }
  return out;
}

/**
 * Distinct rejection reasons behind a `no_usable_face` 422, read from the
 * matcher's per-face diagnostics. An empty `faces` array means the detector
 * found nothing at all, which is its own (and the most common) reason.
 */
function parseFaceReasons(body: Record<string, unknown>): SelfieFaceReason[] | undefined {
  const faces = body.faces;
  if (!Array.isArray(faces)) return undefined;
  if (faces.length === 0) return ['no_face_detected'];
  const reasons = new Set<SelfieFaceReason>();
  for (const face of faces) {
    const raw = (face as { quality?: { reasons?: unknown } })?.quality?.reasons;
    if (!Array.isArray(raw)) continue;
    for (const r of raw) {
      const parsed = SelfieFaceReasonSchema.safeParse(r);
      if (parsed.success) reasons.add(parsed.data);
    }
  }
  return reasons.size > 0 ? [...reasons] : undefined;
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
  image: Buffer;
  filename: string;
  contentType: string;
  eventId: string;
  topK?: number;
  mode?: 'fused' | 'face' | 'person';
}): Promise<MatcherSearchResult> {
  if (!env.MATCHER_URL) {
    return {
      ok: false,
      status: 503,
      error: 'matcher_unconfigured',
      message: 'MATCHER_URL is not set — deploy the matcher and redeploy the api with its URL',
    };
  }

  const url = `${env.MATCHER_URL.replace(/\/$/, '')}/search`;
  const form = new FormData();
  form.set('file', new Blob([new Uint8Array(opts.image)], { type: opts.contentType }), opts.filename);
  form.set('event_id', opts.eventId);
  if (opts.topK !== undefined) form.set('top_k', String(opts.topK));
  if (opts.mode) form.set('mode', opts.mode);

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
    const faceReasons = parseFaceReasons(body);
    return {
      ok: false,
      status: res.status,
      error: typeof body.error === 'string' ? body.error : 'matcher_error',
      message: typeof body.detail === 'string' ? body.detail : `matcher returned ${res.status}`,
      ...(faceReasons ? { faceReasons } : {}),
    };
  }

  const referenceFaces = parseReferenceFaces(body.referenceFaces);
  return {
    ok: true,
    eventId: String(body.eventId ?? opts.eventId),
    mode: (body.mode as 'fused' | 'face' | 'person') ?? 'fused',
    ...(typeof body.modelVersion === 'string' ? { modelVersion: body.modelVersion } : {}),
    ...(referenceFaces ? { referenceFaces } : {}),
    results: (body.results as MatcherSearchHit[]) ?? [],
  };
}
