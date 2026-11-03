/**
 * uploadInsightsService.ts — per-(club, tag, uploader) upload roll-up for one
 * event: sessions, files, bytes, time spent, index coverage, and the sessions
 * that need a look (stuck, failed, never completed, still in staging).
 *
 * Built only from data that is already stored, so a request stays bounded and
 * well inside the 60s Hosting ceiling — never a live Drive walk:
 *
 *   `upload_batches`        one equality query (session + copy-chunk docs)
 *   staging bucket          one prefix listing (what is not in Drive yet)
 *   Upload_Links (Sheet)    linkId → club + tag
 *   Upload_Log (Sheet)      bytes copied, per batch folder
 *   `upload_folder_counts`  ONE doc the indexer writes per run: indexed photos
 *                           per batch folder (indexer/job.py `upload_folders`)
 *
 * Every source but `upload_batches` is optional: a failed read degrades its
 * columns (null / 0) and adds a warning, it never fails the page.
 *
 * The uploader is the `<username>` segment of the session's batch folder
 * (`YYYYMMDD-HHMMSS_<username>`, `buildBatchFolderName`) — the sanitized typed
 * name, which is also what groups their files in Drive.
 */

import type {
  UploadBatchPhase,
  UploadInsightsGroup,
  UploadInsightsResponse,
  UploadInsightsRow,
  UploadInsightsSession,
  UploadSessionStatus,
} from '@cloud-webapp/shared';

import { firestore } from '../lib/firestore.js';
import { logger } from '../lib/logger.js';
import { listLinks } from './linkStore.js';
import { copiedMbByBatchFolder } from './summaryService.js';
import { combinePhases } from './uploadBatchService.js';
import { listStaged, type StagedObject } from './uploadRecoveryService.js';
import { batchFolderUsername } from './volunteerUploadService.js';

/**
 * Still copying with no activity for this long = stuck. Past the 30-min Cloud
 * Tasks dispatch deadline with room for a retry, so a live copy never trips it.
 */
export const STUCK_AFTER_MS = 60 * 60 * 1000;
/** `upload_batches` docs read per request (sessions + 100-file copy chunks). */
export const MAX_BATCH_DOCS = 20_000;
/** Written by the indexer; see indexer/job.py UPLOAD_FOLDERS_COLLECTION. */
export const UPLOAD_FOLDERS_COLLECTION = 'upload_folder_counts';

const DEFAULT_TAG = 'ALL';
const MB = 1024 * 1024;
const IN_PROGRESS: ReadonlySet<UploadBatchPhase> = new Set<UploadBatchPhase>(['received', 'saving']);

/** The `upload_batches` fields this page reads. */
export interface BatchDocLite {
  batchId: string;
  parentBatchId?: string;
  chunked?: boolean;
  linkId?: string;
  phase?: UploadBatchPhase;
  total?: number;
  copied?: number;
  skippedDuplicates?: number;
  failed?: number;
  batchFolderName?: string;
  createdAt?: string;
  updatedAt?: string;
  recoveryDispatchedAt?: string;
  /** Objects that recovery / the sweep dispatched; 0 = it found nothing owed. */
  recoveryObjects?: number;
}

export interface InsightsInput {
  now: number;
  batches: ReadonlyArray<BatchDocLite>;
  staged: ReadonlyArray<StagedObject>;
  /** linkId → club + tag; empty when the Sheet could not be read. */
  links: ReadonlyMap<string, { clubName: string; tag: string }>;
  /** Batch folder → MB copied (Upload_Log); null = unavailable. */
  copiedMbByFolder: ReadonlyMap<string, number> | null;
  /** Batch folder → indexed photos; null = the indexer has not written counts. */
  indexedByFolder: ReadonlyMap<string, number> | null;
  /** A club_admin's club (or a masquerade); undefined = every club. */
  clubScope?: string | undefined;
}

/** The session a doc belongs to: chunks carry `parentBatchId`; ids are a fallback. */
export function sessionIdOf(doc: BatchDocLite): string {
  if (doc.parentBatchId) return doc.parentBatchId;
  // `<session>-p<16 hex>` (uploadChunks.chunkBatchId) or `<session>-recN`
  // (upload recovery). A chunk whose seed write failed has no parentBatchId.
  return doc.batchId.replace(/-(p[0-9a-f]{16}|rec\d+)$/, '');
}

const isRecovery = (d: BatchDocLite): boolean => /-rec\d+$/.test(d.batchId);
const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Math.max(0, Number(v)) : 0);

/** `YYYYMMDD-HHMMSS_<username>` → its UTC epoch ms and username, else null. */
export function parseBatchFolder(name: string): { ms: number; username: string } | null {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})_(.+)$/.exec(name);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, username] = m;
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  return Number.isFinite(ms) ? { ms, username: username ?? '' } : null;
}

const parseMs = (iso: string | undefined): number => {
  const ms = Date.parse(iso ?? '');
  return Number.isFinite(ms) ? ms : 0;
};
const iso = (ms: number): string => (ms > 0 ? new Date(ms).toISOString() : '');

interface SessionAcc extends UploadInsightsSession {
  clubName: string;
  tag: string;
  uploader: string;
}

/** One session from its docs (session + chunks + recoveries) and staged objects. */
function buildSession(
  id: string,
  docs: ReadonlyArray<BatchDocLite>,
  staged: ReadonlyArray<StagedObject>,
  input: InsightsInput,
): SessionAcc {
  const head = docs.find((d) => d.batchId === id);
  const recovered = Boolean(head?.recoveryDispatchedAt);
  // A chunked session's own doc only names the folder; its chunks hold the counts.
  let workers = docs.filter((d) => !(d.batchId === id && d.chunked));
  if (workers.length === 0) workers = [...docs];

  const sum = (k: 'copied' | 'skippedDuplicates' | 'failed'): number =>
    workers.reduce((a, d) => a + n(d[k]), 0);
  const copied = sum('copied');
  const skippedDuplicates = sum('skippedDuplicates');
  const failed = sum('failed');
  // A recovery re-copies files the original docs already counted in `total`.
  const original = workers.filter((d) => !isRecovery(d));
  const totals = (original.length > 0 ? original : workers).reduce((a, d) => a + n(d.total), 0);
  // Files staged after a chunked session's last flush are in no doc's total yet.
  const files = Math.max(totals, copied + skippedDuplicates + staged.length);
  // `failed` is per attempt (a failed file stays staged, or a later attempt copies
  // it), so it is not part of this sum — counting it would count files twice.
  const untracked = files - copied - skippedDuplicates - staged.length;

  const batchFolders = [...new Set(docs.map((d) => (d.batchFolderName ?? '').trim()).filter(Boolean))].sort();

  const startCandidates = [
    ...docs.map((d) => parseMs(d.createdAt)),
    ...batchFolders.map((f) => parseBatchFolder(f)?.ms ?? 0),
    ...staged.map((o) => o.createdMs),
  ].filter((ms) => ms > 0);
  const startMs = startCandidates.length > 0 ? Math.min(...startCandidates) : 0;
  const lastMs = Math.max(
    startMs,
    ...docs.map((d) => parseMs(d.updatedAt)),
    ...staged.map((o) => o.createdMs),
  );

  let status: UploadSessionStatus;
  if (docs.length === 0) {
    status = 'never_completed';
  } else {
    // Once recovery took a session over, a doc its killed worker left mid-copy
    // is superseded, not stuck — the recovery chunks carry the live state.
    const live = workers.filter(
      (d) =>
        !(recovered && !isRecovery(d) && IN_PROGRESS.has(d.phase ?? 'received') &&
          input.now - parseMs(d.updatedAt) > STUCK_AFTER_MS),
    );
    // Recovery found NOTHING owed (every staged file's content already in
    // Drive) and dispatched nothing. When the session had no doc of its own,
    // the marker it wrote is the only one — phase `received`, forever — and was
    // read as stuck (2 on the NYC Marathon event, 2026-11-03). Nothing is
    // pending, so it is done.
    const nothingOwed = recovered && head?.recoveryObjects !== undefined && n(head.recoveryObjects) === 0;
    const phase = combinePhases((live.length > 0 ? live : workers).map((d) => d.phase ?? 'received'));
    if (live.length === 0 && nothingOwed) status = 'ok';
    else if (phase === 'error') status = 'error';
    else if (IN_PROGRESS.has(phase)) status = input.now - lastMs > STUCK_AFTER_MS ? 'stuck' : 'in_progress';
    else status = 'ok';
  }

  const linkId = docs.find((d) => d.linkId)?.linkId ?? staged.find((o) => o.linkId)?.linkId ?? '';
  const link = input.links.get(linkId);
  const clubName = link?.clubName ?? staged[0]?.clubName ?? '';
  const tag = (link?.tag ?? staged[0]?.tag ?? '').trim() || DEFAULT_TAG;
  const fromFolder = batchFolders.map((f) => parseBatchFolder(f)?.username).find(Boolean);
  const typed = staged.find((o) => o.photographerName)?.photographerName;
  const uploader = fromFolder ?? (staged.length > 0 ? batchFolderUsername(typed ?? '') : '');

  const copiedMb = input.copiedMbByFolder;
  const indexedBy = input.indexedByFolder;
  return {
    batchId: id,
    status,
    batchFolders,
    files,
    copied,
    skippedDuplicates,
    failed,
    staged: staged.length,
    untracked,
    copiedBytes: copiedMb ? Math.round(batchFolders.reduce((a, f) => a + (copiedMb.get(f) ?? 0), 0) * MB) : null,
    stagedBytes: staged.reduce((a, o) => a + n(o.size), 0),
    indexed: indexedBy ? batchFolders.reduce((a, f) => a + (indexedBy.get(f) ?? 0), 0) : null,
    startedAt: iso(startMs),
    lastActivityAt: iso(lastMs),
    minutes: startMs > 0 ? (lastMs - startMs) / 60_000 : 0,
    recovered,
    clubName,
    tag,
    uploader,
  };
}

function emptyRow(clubName: string, tag: string, uploader: string, known: InsightsInput): UploadInsightsRow {
  return {
    clubName,
    tag,
    uploader,
    sessions: 0,
    files: 0,
    copied: 0,
    skippedDuplicates: 0,
    failed: 0,
    staged: 0,
    untracked: 0,
    copiedBytes: known.copiedMbByFolder ? 0 : null,
    stagedBytes: 0,
    minutes: 0,
    indexed: known.indexedByFolder ? 0 : null,
    indexRatio: null,
    mbPerSec: null,
    filesPerMin: null,
    inProgress: 0,
    stuck: 0,
    errors: 0,
    neverCompleted: 0,
    recovered: 0,
    firstSessionAt: '',
    lastSessionAt: '',
    lastActivityAt: '',
  };
}

function addSession(row: UploadInsightsRow, s: UploadInsightsSession): void {
  row.sessions += 1;
  row.files += s.files;
  row.copied += s.copied;
  row.skippedDuplicates += s.skippedDuplicates;
  row.failed += s.failed;
  row.staged += s.staged;
  row.untracked += s.untracked;
  if (row.copiedBytes !== null && s.copiedBytes !== null) row.copiedBytes += s.copiedBytes;
  row.stagedBytes += s.stagedBytes;
  row.minutes += s.minutes;
  if (row.indexed !== null && s.indexed !== null) row.indexed += s.indexed;
  if (s.status === 'in_progress') row.inProgress += 1;
  if (s.status === 'stuck') row.stuck += 1;
  if (s.status === 'error') row.errors += 1;
  if (s.status === 'never_completed') row.neverCompleted += 1;
  if (s.recovered) row.recovered += 1;
  if (s.startedAt && (!row.firstSessionAt || s.startedAt < row.firstSessionAt)) row.firstSessionAt = s.startedAt;
  if (s.startedAt > row.lastSessionAt) row.lastSessionAt = s.startedAt;
  if (s.lastActivityAt > row.lastActivityAt) row.lastActivityAt = s.lastActivityAt;
}

/** Ratios last, once the sums are final. */
function finishRow(row: UploadInsightsRow): void {
  row.minutes = Math.round(row.minutes * 10) / 10;
  // Untracked files are in Drive too (see the schema), so they count as copied
  // here — otherwise a retried session reads well over 100% once indexed.
  const inDrive = row.copied + row.untracked;
  row.indexRatio = row.indexed !== null && inDrive > 0 ? row.indexed / inDrive : null;
  const seconds = row.minutes * 60;
  row.mbPerSec = row.copiedBytes !== null && seconds > 0 ? row.copiedBytes / MB / seconds : null;
  row.filesPerMin = row.minutes > 0 ? row.copied / row.minutes : null;
}

function groupBy<T>(items: ReadonlyArray<T>, keyOf: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const list = out.get(key);
    if (list) list.push(item);
    else out.set(key, [item]);
  }
  return out;
}

/** The pure roll-up: sessions grouped per (club, tag, uploader), plus totals. */
export function buildUploadInsights(input: InsightsInput): { groups: UploadInsightsGroup[]; totals: UploadInsightsRow } {
  const docsBySession = groupBy(input.batches, sessionIdOf);
  const stagedBySession = groupBy(input.staged, (o) => o.batchId);

  const ids = new Set([...docsBySession.keys(), ...stagedBySession.keys()]);
  const groups = new Map<string, UploadInsightsGroup>();
  const totals = emptyRow('', '', '', input);

  for (const id of ids) {
    const { clubName, tag, uploader, ...session } = buildSession(
      id,
      docsBySession.get(id) ?? [],
      stagedBySession.get(id) ?? [],
      input,
    );
    if (input.clubScope !== undefined && clubName !== input.clubScope) continue;
    const key = JSON.stringify([clubName, tag, uploader]);
    const group = groups.get(key) ?? { ...emptyRow(clubName, tag, uploader, input), sessionList: [] };
    addSession(group, session);
    group.sessionList.push(session);
    groups.set(key, group);
    addSession(totals, session);
  }

  for (const g of groups.values()) {
    finishRow(g);
    g.sessionList.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }
  finishRow(totals);
  const sorted = [...groups.values()].sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
  return { groups: sorted, totals };
}

const BATCH_FIELDS = [
  'batchId',
  'parentBatchId',
  'chunked',
  'linkId',
  'phase',
  'total',
  'copied',
  'skippedDuplicates',
  'failed',
  'batchFolderName',
  'createdAt',
  'updatedAt',
  'recoveryDispatchedAt',
  'recoveryObjects',
];

/**
 * Load every source for one event and roll it up. `spreadsheetId` null = no
 * master Sheet configured (club/tag then come from staged metadata only).
 */
export async function loadUploadInsights(
  eventId: string,
  opts: { spreadsheetId: string | null; clubScope?: string | undefined; now?: number },
): Promise<UploadInsightsResponse> {
  const warnings: string[] = [];
  const sid = opts.spreadsheetId;

  const [batchSnap, staged, links, copiedMb, folderDoc] = await Promise.allSettled([
    firestore()
      .collection('upload_batches')
      .where('eventId', '==', eventId)
      .select(...BATCH_FIELDS)
      .limit(MAX_BATCH_DOCS + 1)
      .get(),
    listStaged(eventId),
    sid ? listLinks(sid, { eventId }) : Promise.resolve([]),
    sid ? copiedMbByBatchFolder(sid, eventId) : Promise.resolve(null),
    firestore().collection(UPLOAD_FOLDERS_COLLECTION).doc(eventId).get(),
  ]);

  // The session docs are the page; without them there is nothing to show.
  if (batchSnap.status === 'rejected') throw batchSnap.reason;
  const docs = batchSnap.value.docs.slice(0, MAX_BATCH_DOCS);
  const truncated = batchSnap.value.docs.length > MAX_BATCH_DOCS;
  if (truncated) warnings.push(`Only the first ${MAX_BATCH_DOCS} upload records were read; totals are partial.`);
  const batches: BatchDocLite[] = docs.map((d) => ({ ...d.data(), batchId: d.id }) as BatchDocLite);

  const fail = (what: string, reason: unknown): void => {
    logger.warn({ err: reason, eventId }, `upload insights: ${what} unavailable (non-fatal)`);
  };

  let stagedObjs: StagedObject[] = [];
  if (staged.status === 'fulfilled') stagedObjs = staged.value;
  else {
    fail('staging listing', staged.reason);
    warnings.push('Could not list the staging bucket — "In staging" and never-completed sessions are missing.');
  }

  const linkMap = new Map<string, { clubName: string; tag: string }>();
  if (links.status === 'fulfilled') {
    for (const l of links.value) linkMap.set(l.linkId, { clubName: l.clubName, tag: l.tag });
  } else {
    fail('Upload_Links', links.reason);
    warnings.push('Could not read upload links — club / tag may be blank for some sessions.');
  }

  let copiedMbByFolder: Map<string, number> | null = null;
  if (copiedMb.status === 'fulfilled') copiedMbByFolder = copiedMb.value;
  else {
    fail('Upload_Log', copiedMb.reason);
    warnings.push('Could not read the Upload_Log tab — copied sizes are unknown.');
  }
  if (!sid) warnings.push('No master Sheet configured — copied sizes and link club / tag are unavailable.');

  let indexedByFolder: Map<string, number> | null = null;
  let indexCountsAt: string | null = null;
  if (folderDoc.status === 'fulfilled' && folderDoc.value.exists) {
    const data = folderDoc.value.data() ?? {};
    indexedByFolder = new Map();
    for (const f of Array.isArray(data.folders) ? data.folders : []) {
      const name = String(f?.batchFolder ?? '');
      if (name) indexedByFolder.set(name, (indexedByFolder.get(name) ?? 0) + n(f?.count));
    }
    indexCountsAt = String(data.updatedAt ?? '') || null;
    if (data.truncated) warnings.push('The index counts were capped by the indexer; some index % read low.');
  } else if (folderDoc.status === 'rejected') {
    fail('index counts', folderDoc.reason);
    warnings.push('Could not read the index counts — index % is unknown.');
  }

  const { groups, totals } = buildUploadInsights({
    now: opts.now ?? Date.now(),
    batches,
    staged: stagedObjs,
    links: linkMap,
    copiedMbByFolder,
    indexedByFolder,
    clubScope: opts.clubScope,
  });

  return {
    ok: true,
    eventId,
    generatedAt: new Date(opts.now ?? Date.now()).toISOString(),
    indexCountsAt,
    stagingListed: staged.status === 'fulfilled',
    truncated,
    warnings,
    totals,
    groups,
  };
}
