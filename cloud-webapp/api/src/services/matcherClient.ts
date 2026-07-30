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

import {
  ReferenceFacesSchema,
  SelfieFaceReasonSchema,
  type ReferenceFaces,
  type SelfieFaceReason,
} from '@cloud-webapp/shared';

import { env } from '../lib/config.js';
import { getIdTokenHeaders } from '../lib/googleCredentials.js';

export interface MatcherSearchHit {
  photoId: string;
  score: number;
  faceScore: number | null;
  personScore: number | null;
}

/** Matcher's nomination for a better (in-domain) reference — see
 *  `AnchorSuggestionSchema` in shared for what the fields mean. */
export interface MatcherAnchorSuggestion {
  photoId: string;
  suitability: number;
  faceScore: number;
  faceCount: number;
  facePx: number;
  frontality: number | null;
  faceFrac: number | null;
  qualityKnown: boolean;
}

export type MatcherSearchResult =
  | {
      ok: true;
      eventId: string;
      mode: 'fused' | 'face' | 'person';
      modelVersion?: string;
      normalized?: boolean;
      /**
       * Anchors the matcher actually folded in (unknown photoIds are dropped).
       * Optional because the api and the matcher deploy independently: a matcher
       * revision older than this api simply omits these three fields, and a
       * search must still succeed rather than 500 mid-rollout.
       */
      anchorPhotoIds?: string[];
      anchorSuggestion?: MatcherAnchorSuggestion | null;
      /** Candidate-side quality weighting the matcher applied (0 = off). */
      faceQualityWeight?: number;
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

/** One picked selfie's verdict from POST /quality (detection only). */
export interface MatcherSelfieReport {
  index: number;
  filename: string;
  usable: boolean;
  reasons: string[];
  advisories: string[];
  selfieScore: number;
  faceCount: number;
  faceScore?: number;
  /** Normalized box of the graded face, for the client's crop preview. */
  faceBox?: [number, number, number, number] | null;
  frontality: number | null;
  faceFrac?: number;
  facePx?: number;
  blur?: number;
}

export type MatcherQualityResult =
  | { ok: true; files: MatcherSelfieReport[]; bestIndex: number | null; anyUsable: boolean }
  | { ok: false; status: number; error: string; message: string };

/** One reference selfie for the query. Passing more than one builds a
 *  centroid query on the matcher (§1.1) — averages out any single shot's
 *  pose/blur. */
export interface MatcherReferenceImage {
  image: Buffer;
  filename: string;
  contentType: string;
}

function authHeaders(url: string): Promise<Record<string, string>> {
  return getIdTokenHeaders(env.MATCHER_URL, url);
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
  /** Event photoIds to anchor the query on. Unlike `prfPhotoIds` these are
   *  explicit, quality-gated picks, and the anchor's outfit REPLACES the
   *  selfie's in the person half of the query (anchor promotion). */
  anchorPhotoIds?: string[];
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
  if (opts.anchorPhotoIds?.length) form.set('anchor_photo_ids', opts.anchorPhotoIds.join(','));
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
    ...(typeof body.normalized === 'boolean' ? { normalized: body.normalized } : {}),
    anchorPhotoIds: Array.isArray(body.anchorPhotoIds) ? (body.anchorPhotoIds as string[]) : [],
    anchorSuggestion: (body.anchorSuggestion as MatcherAnchorSuggestion | null) ?? null,
    faceQualityWeight: typeof body.faceQualityWeight === 'number' ? body.faceQualityWeight : 0,
    ...(referenceFaces ? { referenceFaces } : {}),
    results: (body.results as MatcherSearchHit[]) ?? [],
  };
}

/**
 * POST /quality on the matcher: grade picked selfies before searching with them.
 * Detection only — no embeddings are computed and nothing is persisted, so this
 * is safe (and cheap) to call every time the user changes their selection.
 */
export async function matcherQualityCheck(opts: {
  images: MatcherReferenceImage[];
}): Promise<MatcherQualityResult> {
  if (!env.MATCHER_URL) {
    return {
      ok: false,
      status: 503,
      error: 'matcher_unconfigured',
      message: 'MATCHER_URL is not set — deploy the matcher and redeploy the api with its URL',
    };
  }
  if (opts.images.length === 0) {
    return { ok: false, status: 400, error: 'missing_file', message: 'no image provided' };
  }

  const url = `${env.MATCHER_URL.replace(/\/$/, '')}/quality`;
  const form = new FormData();
  for (const ref of opts.images) {
    form.append('file', new Blob([new Uint8Array(ref.image)], { type: ref.contentType }), ref.filename);
  }

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

  const files = (body.files as MatcherSelfieReport[]) ?? [];
  return {
    ok: true,
    files,
    bestIndex: typeof body.bestIndex === 'number' ? body.bestIndex : null,
    anyUsable: body.anyUsable === true,
  };
}
