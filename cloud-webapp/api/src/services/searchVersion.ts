/**
 * searchVersion.ts — derive a search's version tag from the config it ran with
 * (quality plan Item 23).
 *
 * `SEARCH_ALGO_VERSION` was a hand-bumped constant, and it sat unchanged for two
 * months while real person crops, anchor suggestions and a cutoff raise all went
 * live — so votes cast under different rankers carried one tag and could not be
 * told apart. The tag is now `<generation>+<fingerprint>`:
 *
 *   - generation: the constant, kept as a human-readable era for grouping
 *     (`export_feedback_labels.py --search-version 2026.09` is a prefix match, so
 *     it keeps working);
 *   - fingerprint: 8 hex chars of a hash over the config the MATCHER REPORTED
 *     applying. A change to any of them changes the tag by itself.
 *
 * `indexModelVersion` is per event (it encodes that event's person-crop
 * geometry), so two events can legitimately carry different tags under one
 * deploy — that is the point: their results were produced by different stores.
 * Per-search choices (PRF count, anchors, number of selfies) are NOT config and
 * stay in their own `algo` fields.
 */

import { createHash } from 'node:crypto';
import type { SearchConfig } from '@cloud-webapp/shared';

/** Key-sorted JSON, so field order can never change the hash. */
function canonical(config: SearchConfig): string {
  const entries = Object.entries(config).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(Object.fromEntries(entries));
}

export function configFingerprint(config: SearchConfig): string {
  return createHash('sha256').update(canonical(config)).digest('hex').slice(0, 8);
}

export function deriveSearchVersion(generation: string, config: SearchConfig): string {
  return `${generation}+${configFingerprint(config)}`;
}
