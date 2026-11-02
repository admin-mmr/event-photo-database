/**
 * uploadChunks.ts — split a volunteer upload into copy chunks.
 *
 * One /complete used to become ONE Cloud Tasks job that copied every file to
 * Drive in sequence, at ~3 s a photo. A 1,583-photo upload (NYC Marathon,
 * 2026-11-02) needed ~85 min — past the 30-min task deadline, so it crawled
 * through retries — while the other nine queue slots sat idle. Splitting it
 * into chunks of COPY_CHUNK_FILES lets the queue copy one session in parallel,
 * and keeps every task far inside the deadline.
 *
 * A chunk's id is derived from its CONTENT, not its position, so a repeated
 * /complete (a client retry, or a flush racing the page-hide beacon) maps to
 * the same Cloud Tasks name and is deduplicated there (409) instead of
 * copying twice.
 */

import { createHash } from 'node:crypto';

/** Files per copy task: ~5 min of copying at the measured ~3 s/photo. */
export const COPY_CHUNK_FILES = 100;

export function chunkObjectNames(objectNames: ReadonlyArray<string>, size = COPY_CHUNK_FILES): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < objectNames.length; i += size) out.push(objectNames.slice(i, i + size));
  return out;
}

/** Stable chunk id: `<sessionBatchId>-p<hash of its object names>`. */
export function chunkBatchId(sessionBatchId: string, objectNames: ReadonlyArray<string>): string {
  const hash = createHash('sha256').update([...objectNames].sort().join('\n')).digest('hex').slice(0, 16);
  return `${sessionBatchId}-p${hash}`;
}
