import { z } from 'zod';

/**
 * "Sync with Drive" reconciler contracts (dev plan §8 — cutover/ops).
 *
 * The reconciler reads the master Google Sheet (the source of truth that the
 * gas-app admin workflow writes to) and upserts events + per-event tags into
 * Firestore so the cloud webapp's gallery and Find Me see the same events
 * without anyone re-entering them by hand. Drive/Sheets stays authoritative;
 * the Firestore copy is derived.
 *
 * Reconcile policy is **report-only**: rows in the Sheet are upserted (merged,
 * so cloud-owned fields like `indexState`/`visibility` survive), and events
 * present in Firestore but absent from the Sheet are reported as `orphans`,
 * never deleted.
 */

/** Per-event outcome of a sync run. */
export const SyncEventResultSchema = z.object({
  eventId: z.string(),
  name: z.string(),
  action: z.enum(['created', 'updated', 'unchanged']),
  /** Distinct tags written for this event (from Upload_Links rows). */
  tags: z.array(z.string()),
});
export type SyncEventResult = z.infer<typeof SyncEventResultSchema>;

export const SyncResultSchema = z.object({
  spreadsheetId: z.string(),
  /** Event rows read from the Sheet (excludes the header row). */
  scanned: z.number().int().nonnegative(),
  created: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  unchanged: z.number().int().nonnegative(),
  /** Total distinct (event, tag) pairs written across all events. */
  tagsLinked: z.number().int().nonnegative(),
  /** Firestore event ids not present in the Sheet (reported, not deleted). */
  orphans: z.array(z.string()),
  events: z.array(SyncEventResultSchema),
  durationMs: z.number().int().nonnegative(),
});
export type SyncResult = z.infer<typeof SyncResultSchema>;

export const SyncResponseSchema = SyncResultSchema.extend({
  ok: z.literal(true),
});
export type SyncResponse = z.infer<typeof SyncResponseSchema>;
