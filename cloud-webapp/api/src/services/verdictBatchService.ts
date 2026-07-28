/**
 * verdictBatchService.ts — reads that group match feedback into *batches*.
 *
 * A batch is one Find Me search run (`match_runs` id, carried on every vote as
 * `runId`) plus the selfie it was searched with and every verdict the searcher
 * marked against its results. The flat admin queue (routes/feedback.ts) answers
 * "what was voted on"; this answers "what did this person say about this one
 * search" — which is the view you need to judge whether the matcher got it
 * right, because a lone "not me" row means little without the query face and its
 * sibling verdicts next to it.
 *
 * Read-only. All access is admin-gated and audited at the route
 * (routes/adminVerdicts.ts) — it exposes another user's selfie.
 *
 * Query shape follows the rest of the Find Me admin tooling: a single bounded
 * `orderBy('createdAt')` scan (or one `where('runId','==')` equality) with the
 * filtering done in memory, so no composite index is needed.
 */

import {
  SearchAlgoSchema,
  type FeedbackVerdict,
  type VerdictBatch,
  type VerdictBatchDetail,
  type VerdictBatchVote,
} from '@cloud-webapp/shared';

import { firestore } from '../lib/firestore.js';
import { logger } from '../lib/logger.js';
import { signReferenceUrl, signThumbUrls } from './gcsService.js';
import { getReference, listReferencesForUidRaw, type ReferenceRecord } from './references.js';

/** Votes read in one list scan. Bounds cost; `capped` reports when it bites. */
const FEEDBACK_SCAN_LIMIT = 500;
/** Batches returned by the list, before/after clamping the caller's `limit`. */
const LIST_DEFAULT = 25;
const LIST_MAX = 100;
/**
 * Votes resolved for one batch. A batch is one person's clicking, so real ones
 * are far smaller; this only stops a pathological run from turning into hundreds
 * of parallel signBlob calls.
 */
const MAX_BATCH_VOTES = 200;

interface VoteRow {
  feedbackId: string;
  eventId: string;
  photoId: string;
  verdict: FeedbackVerdict;
  runId: string | null;
  uid: string;
  email: string | null;
  createdAt: string;
}

/** The subset of a `match_runs` doc a batch header needs. */
interface RunInfo {
  uid: string;
  eventId: string;
  createdAt: string | null;
  mode: string | null;
  modelVersion: string | null;
  uploadId: string | null;
  searcherName: string | null;
  resultCount: number | null;
  /** photoId → matcher score, when the run recorded scores. */
  scores: Record<string, number>;
  /** photoId → 1-based position in the run's result list. */
  ranks: Map<string, number>;
  algo: ReturnType<typeof SearchAlgoSchema.safeParse>['data'] | null;
}

function toVoteRow(id: string, data: Record<string, unknown>): VoteRow {
  return {
    feedbackId: id,
    eventId: String(data.eventId ?? ''),
    photoId: String(data.photoId ?? ''),
    verdict: data.verdict as FeedbackVerdict,
    runId: (data.runId as string | null) ?? null,
    uid: String(data.uid ?? ''),
    email: (data.email as string | null) ?? null,
    createdAt: String(data.createdAt ?? ''),
  };
}

async function loadRun(runId: string): Promise<RunInfo | null> {
  const snap = await firestore().collection('match_runs').doc(runId).get();
  if (!snap.exists) return null;
  const data = snap.data() ?? {};
  const resultPhotoIds = Array.isArray(data.resultPhotoIds) ? (data.resultPhotoIds as string[]) : [];
  const rawScores = (data.scores ?? {}) as Record<string, unknown>;
  const scores: Record<string, number> = {};
  for (const [photoId, score] of Object.entries(rawScores)) {
    if (typeof score === 'number' && Number.isFinite(score)) scores[photoId] = score;
  }
  return {
    uid: String(data.uid ?? ''),
    eventId: String(data.eventId ?? ''),
    createdAt: data.createdAt ? String(data.createdAt) : null,
    mode: data.mode ? String(data.mode) : null,
    modelVersion: (data.modelVersion as string | null) ?? null,
    uploadId: (data.uploadId as string | null) ?? null,
    searcherName: (data.searcherName as string | null) ?? null,
    resultCount: resultPhotoIds.length > 0 ? resultPhotoIds.length : null,
    scores,
    ranks: new Map(resultPhotoIds.map((photoId, i) => [photoId, i + 1])),
    algo: SearchAlgoSchema.safeParse(data.algo).data ?? null,
  };
}

/**
 * Per-request memo for the reference lookups, so N batches from the same
 * searcher cost one Firestore query instead of N.
 */
type ReferenceCache = Map<string, Promise<ReferenceRecord[]>>;

/**
 * The selfie a run searched with.
 *
 * Runs written since the verdict-batch feature carry `uploadId` directly. For
 * OLDER runs we fall back to joining `find_me_uploads` on
 * (uid, eventId, exact createdAt): `runSearch` stamps the reference record and
 * the run from the same `nowIso`, so the timestamps are identical, not merely
 * close — which makes the join exact for fresh-upload searches. Older *reuse*
 * searches wrote no reference record at all and simply have no selfie to show.
 */
async function resolveSelfie(
  run: RunInfo | null,
  identity: { uid: string; eventId: string },
  cache: ReferenceCache,
): Promise<{ selfieUrl: string | null; selfieUploadId: string | null; name: string | null }> {
  let rec: ReferenceRecord | null = null;
  try {
    if (run?.uploadId) {
      rec = await getReference(run.uploadId);
    } else if (run?.createdAt) {
      let pending = cache.get(identity.uid);
      if (!pending) {
        pending = listReferencesForUidRaw(identity.uid);
        cache.set(identity.uid, pending);
      }
      rec =
        (await pending).find((r) => r.eventId === identity.eventId && r.createdAt === run.createdAt) ??
        null;
    }
  } catch (err) {
    logger.warn({ err, uid: identity.uid }, 'verdict batch: selfie lookup failed (non-fatal)');
  }
  if (!rec) return { selfieUrl: null, selfieUploadId: run?.uploadId ?? null, name: run?.searcherName ?? null };

  // Signing a deleted/expired object still succeeds (V4 signing never touches
  // the object), so a broken image is possible here; the UI degrades to a
  // placeholder rather than pretending the selfie is gone.
  let selfieUrl: string | null = null;
  try {
    selfieUrl = await signReferenceUrl(rec.gcsPath);
  } catch (err) {
    logger.warn({ err, uploadId: rec.uploadId }, 'verdict batch: selfie signing failed (non-fatal)');
  }
  return {
    selfieUrl,
    selfieUploadId: rec.uploadId,
    name: rec.name ?? run?.searcherName ?? null,
  };
}

function countVerdicts(votes: VoteRow[]): { not_me: number; confirmed: number } {
  return {
    not_me: votes.filter((v) => v.verdict === 'not_me').length,
    confirmed: votes.filter((v) => v.verdict === 'confirmed').length,
  };
}

/**
 * Assemble a batch header from its votes + (optional) run record. Identity comes
 * from the votes when there are any (they share a searcher and an event — they
 * came from one search) and from the run otherwise, so a batch whose verdicts
 * were individually erased still describes itself.
 */
async function buildHeader(
  runId: string,
  votes: VoteRow[],
  run: RunInfo | null,
  cache: ReferenceCache,
): Promise<VerdictBatch> {
  // The newest vote is the batch's ordering key.
  const newest = votes.length
    ? votes.reduce((a, b) => (b.createdAt > a.createdAt ? b : a), votes[0]!)
    : null;
  const identity = {
    uid: newest?.uid ?? run?.uid ?? '',
    eventId: newest?.eventId ?? run?.eventId ?? '',
  };
  const selfie = await resolveSelfie(run, identity, cache);
  const counts = countVerdicts(votes);
  return {
    runId,
    eventId: identity.eventId,
    uid: identity.uid,
    email: newest?.email ?? null,
    name: selfie.name,
    markedAt: newest?.createdAt ?? '',
    searchedAt: run?.createdAt ?? null,
    mode: run?.mode ?? null,
    modelVersion: run?.modelVersion ?? null,
    searchVersion: run?.algo?.version ?? null,
    algo: run?.algo ?? null,
    resultCount: run?.resultCount ?? null,
    selfieUrl: selfie.selfieUrl,
    selfieUploadId: selfie.selfieUploadId,
    counts,
    total: counts.not_me + counts.confirmed,
  };
}

export interface VerdictBatchFilter {
  eventId?: string;
  uid?: string;
  /** Case-insensitive exact match on the recorded account email. */
  email?: string;
  limit?: number;
}

export interface VerdictBatchListResult {
  batches: VerdictBatch[];
  /** Votes in the scanned window with no runId — they belong to no batch. */
  unattributed: number;
  /** The scan filled its window; older batches may exist beyond it. */
  capped: boolean;
}

/**
 * Recent verdict batches, newest-marked first.
 *
 * Filters are applied to the VOTES before grouping, so `eventId=ev1` yields
 * batches for that event only (a batch never spans events). A vote with no
 * `runId` can't be attributed to a search and is only counted, in
 * `unattributed`.
 */
export async function listVerdictBatches(
  filter: VerdictBatchFilter = {},
): Promise<VerdictBatchListResult> {
  const limit = Math.min(Math.max(filter.limit ?? LIST_DEFAULT, 1), LIST_MAX);
  const snap = await firestore()
    .collection('match_feedback')
    .orderBy('createdAt', 'desc')
    .limit(FEEDBACK_SCAN_LIMIT)
    .get();

  let rows = snap.docs.map((d) => toVoteRow(d.id, d.data()));
  const capped = snap.docs.length >= FEEDBACK_SCAN_LIMIT;
  if (filter.eventId) rows = rows.filter((r) => r.eventId === filter.eventId);
  if (filter.uid) rows = rows.filter((r) => r.uid === filter.uid);
  if (filter.email) {
    const wanted = filter.email.toLowerCase();
    rows = rows.filter((r) => (r.email ?? '').toLowerCase() === wanted);
  }

  const unattributed = rows.filter((r) => !r.runId).length;
  const byRun = new Map<string, VoteRow[]>();
  for (const row of rows) {
    if (!row.runId) continue;
    const list = byRun.get(row.runId);
    if (list) list.push(row);
    else byRun.set(row.runId, [row]);
  }

  // Newest-marked batch first, then resolve only the page we return — each
  // header costs a run read and (usually) a selfie signature.
  const ordered = [...byRun.entries()]
    .map(([runId, votes]) => ({
      runId,
      votes,
      markedAt: votes.reduce((a, v) => (v.createdAt > a ? v.createdAt : a), ''),
    }))
    .sort((a, b) => b.markedAt.localeCompare(a.markedAt))
    .slice(0, limit);

  const cache: ReferenceCache = new Map();
  const batches = await Promise.all(
    ordered.map(async (g) => buildHeader(g.runId, g.votes, await loadRun(g.runId), cache)),
  );
  return { batches, unattributed, capped };
}

/**
 * One batch with every verdict resolved for display: photo thumbnails plus the
 * score and rank the matcher gave each voted-on photo in that run.
 *
 * Returns null when the runId has no votes AND no run record — an unknown or
 * already-erased batch (deleting My Data cascades both).
 */
export async function getVerdictBatch(runId: string): Promise<VerdictBatchDetail | null> {
  const [snap, run] = await Promise.all([
    firestore().collection('match_feedback').where('runId', '==', runId).get(),
    loadRun(runId),
  ]);
  const rows = snap.docs.map((d) => toVoteRow(d.id, d.data()));
  if (rows.length === 0 && !run) return null;

  const cache: ReferenceCache = new Map();
  const header = await buildHeader(runId, rows, run, cache);

  // Ordered by the run's own ranking so the admin reads the verdicts in the
  // order the searcher saw the results; unranked photos (score-less/older runs)
  // fall to the end, oldest vote first.
  const ordered = rows
    .slice()
    .sort((a, b) => {
      const ra = run?.ranks.get(a.photoId) ?? Number.MAX_SAFE_INTEGER;
      const rb = run?.ranks.get(b.photoId) ?? Number.MAX_SAFE_INTEGER;
      if (ra !== rb) return ra - rb;
      return a.createdAt.localeCompare(b.createdAt);
    })
    .slice(0, MAX_BATCH_VOTES);
  if (rows.length > ordered.length) {
    logger.warn({ runId, votes: rows.length, shown: ordered.length }, 'verdict batch truncated');
  }

  let thumbs = new Map<string, string>();
  if (ordered.length > 0) {
    try {
      const signed = await signThumbUrls(
        header.eventId,
        ordered.map((v) => v.photoId),
      );
      thumbs = new Map(signed.map((s) => [s.photoId, s.thumbUrl]));
    } catch (err) {
      // A signing failure costs the pictures, not the verdicts — still render.
      logger.warn({ err, runId }, 'verdict batch: thumb signing failed (non-fatal)');
    }
  }

  const votes: VerdictBatchVote[] = ordered.map((v) => ({
    feedbackId: v.feedbackId,
    photoId: v.photoId,
    verdict: v.verdict,
    createdAt: v.createdAt,
    thumbUrl: thumbs.get(v.photoId) ?? '',
    score: run?.scores[v.photoId] ?? null,
    rank: run?.ranks.get(v.photoId) ?? null,
  }));

  return { ...header, votes };
}
