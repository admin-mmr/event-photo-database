/**
 * outfitClient.ts — call the private outfit-tagger Cloud Run service.
 *
 * Auth: the service deploys without --allow-unauthenticated; we mint an IAM ID
 * token for its URL (audience) via google-auth-library, which on Cloud Run uses
 * the metadata server — keyless, identical to `matcherClient.ts`.
 *
 * The outfit-tagger is a separate deployable from the matcher, so every field
 * below is treated as optional-on-the-wire: the two services roll out
 * independently and a response from an older revision must degrade to a missing
 * hint rather than throwing mid-request. Same posture the matcher client takes
 * with `anchorSuggestion` / `faceQualityWeight`.
 */

import { env } from '../lib/config.js';
import { getIdTokenHeaders } from '../lib/googleCredentials.js';

/** One ranked photo. `score` is a z-score against the event cohort, NOT a
 *  cosine — see outfit-tagger/scoring.py. There is deliberately no default
 *  threshold, so callers rank/shortlist rather than auto-confirm. */
export interface OutfitHit {
  photoId: string;
  score: number;
  region: 'person' | 'head' | null;
  box: number[] | null;
  /** Per-modality z-scores for the winning crop: which half drove the hit. */
  sampleScore: number | null;
  textScore: number | null;
}

export type OutfitDetectResult =
  | {
      ok: true;
      eventId: string;
      modelVersion?: string;
      region: string;
      scoreUnit: string;
      textWeight: number | null;
      sampleCount: number;
      samplePhotoIds: string[];
      unknownPhotoIds: string[];
      cohortSize: number;
      /** Present when the description names something the text tower reads
       *  poorly (fine-grained gear, brands) — surfaced so a weak result is read
       *  as "text couldn't see it", not "not in this event". */
      textAdvisory?: string;
      results: OutfitHit[];
    }
  | { ok: false; status: number; error: string; message: string };

export type OutfitStatusResult =
  | {
      ok: true;
      eventId: string;
      prepared: boolean;
      crops?: number;
      regions?: Record<string, number>;
      photos?: number;
      modelVersion?: string;
      sourceModelVersion?: string;
      skipped?: number;
    }
  | { ok: false; status: number; error: string; message: string };

export interface OutfitSampleImage {
  image: Buffer;
  filename: string;
  contentType: string;
}

function unconfigured(): { ok: false; status: number; error: string; message: string } {
  return {
    ok: false,
    status: 503,
    error: 'outfit_unconfigured',
    message:
      'OUTFIT_URL is not set — deploy the outfit-tagger and redeploy the api with its URL',
  };
}

function authHeaders(url: string): Promise<Record<string, string>> {
  return getIdTokenHeaders(env.OUTFIT_URL, url);
}

function baseUrl(): string {
  return env.OUTFIT_URL.replace(/\/$/, '');
}

/** Is this event prepared, and with which model? Cheap — no model load on the
 *  service side, so it is safe to call on every page load of the admin UI. */
export async function outfitStatus(eventId: string): Promise<OutfitStatusResult> {
  if (!env.OUTFIT_URL) return unconfigured();

  const url = `${baseUrl()}/status?event_id=${encodeURIComponent(eventId)}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: await authHeaders(url) });
  } catch (err) {
    return {
      ok: false,
      status: 502,
      error: 'outfit_unreachable',
      message: err instanceof Error ? err.message : String(err),
    };
  }

  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error: typeof body.error === 'string' ? body.error : 'outfit_error',
      message: typeof body.detail === 'string' ? body.detail : `outfit-tagger returned ${res.status}`,
    };
  }
  return {
    ok: true,
    eventId: String(body.eventId ?? eventId),
    prepared: body.prepared === true,
    ...(typeof body.crops === 'number' ? { crops: body.crops } : {}),
    ...(body.regions && typeof body.regions === 'object'
      ? { regions: body.regions as Record<string, number> }
      : {}),
    ...(typeof body.photos === 'number' ? { photos: body.photos } : {}),
    ...(typeof body.modelVersion === 'string' ? { modelVersion: body.modelVersion } : {}),
    ...(typeof body.sourceModelVersion === 'string'
      ? { sourceModelVersion: body.sourceModelVersion }
      : {}),
    ...(typeof body.skipped === 'number' ? { skipped: body.skipped } : {}),
  };
}

/**
 * POST /detect: sample crops and/or a text description → per-photo ranking.
 *
 * Samples are the strong modality; text is reliable for coarse visual attributes
 * ("orange singlet") and weak for fine-grained gear names. Uploaded samples are
 * embedded WHOLE by the service, so they should be cropped tight to the garment
 * or accessory — `samplePhotoIds` is the cheaper and better-framed alternative,
 * since those crops are already rows in the event's index.
 */
export async function outfitDetect(opts: {
  eventId: string;
  samples?: OutfitSampleImage[];
  samplePhotoIds?: string[];
  text?: string;
  textWeight?: number;
  region?: 'person' | 'head' | 'auto';
  topK?: number;
  minScore?: number;
  includeSmall?: boolean;
}): Promise<OutfitDetectResult> {
  if (!env.OUTFIT_URL) return unconfigured();

  const samples = opts.samples ?? [];
  const text = opts.text?.trim() ?? '';
  if (samples.length === 0 && !(opts.samplePhotoIds?.length ?? 0) && !text) {
    return {
      ok: false,
      status: 400,
      error: 'missing_query',
      message: 'provide sample images, samplePhotoIds, and/or text',
    };
  }

  const url = `${baseUrl()}/detect`;
  const form = new FormData();
  for (const sample of samples) {
    form.append(
      'file',
      new Blob([new Uint8Array(sample.image)], { type: sample.contentType }),
      sample.filename,
    );
  }
  form.set('event_id', opts.eventId);
  if (text) form.set('text', text);
  if (opts.textWeight !== undefined) form.set('text_weight', String(opts.textWeight));
  if (opts.samplePhotoIds?.length) form.set('sample_photo_ids', opts.samplePhotoIds.join(','));
  if (opts.region) form.set('region', opts.region);
  if (opts.topK !== undefined) form.set('top_k', String(opts.topK));
  if (opts.minScore !== undefined) form.set('min_score', String(opts.minScore));
  if (opts.includeSmall) form.set('include_small', '1');

  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers: await authHeaders(url), body: form });
  } catch (err) {
    return {
      ok: false,
      status: 502,
      error: 'outfit_unreachable',
      message: err instanceof Error ? err.message : String(err),
    };
  }

  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error: typeof body.error === 'string' ? body.error : 'outfit_error',
      message: typeof body.detail === 'string' ? body.detail : `outfit-tagger returned ${res.status}`,
    };
  }

  return {
    ok: true,
    eventId: String(body.eventId ?? opts.eventId),
    ...(typeof body.modelVersion === 'string' ? { modelVersion: body.modelVersion } : {}),
    region: typeof body.region === 'string' ? body.region : (opts.region ?? 'auto'),
    scoreUnit: typeof body.scoreUnit === 'string' ? body.scoreUnit : 'zscore',
    textWeight: typeof body.textWeight === 'number' ? body.textWeight : null,
    sampleCount: typeof body.sampleCount === 'number' ? body.sampleCount : 0,
    samplePhotoIds: Array.isArray(body.samplePhotoIds) ? (body.samplePhotoIds as string[]) : [],
    unknownPhotoIds: Array.isArray(body.unknownPhotoIds) ? (body.unknownPhotoIds as string[]) : [],
    cohortSize: typeof body.cohortSize === 'number' ? body.cohortSize : 0,
    ...(typeof body.textAdvisory === 'string' ? { textAdvisory: body.textAdvisory } : {}),
    results: Array.isArray(body.results) ? (body.results as OutfitHit[]) : [],
  };
}
