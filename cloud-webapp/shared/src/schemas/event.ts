import { z } from 'zod';

/**
 * Event + indexing contracts (dev plan M1; PRD §6.2 `events` collection).
 * The Firestore doc may hold more fields (gas-app era) — these schemas are
 * the API surface only, so extra fields are stripped, not rejected.
 */

export const IndexStateSchema = z.object({
  status: z.enum(['queued', 'running', 'done', 'failed']),
  /** ISO-8601 timestamp of the last indexState write (queued/running/done/
   *  failed). Surfaced in the UI as "last updated". */
  updatedAt: z.string().optional(),
  modelVersion: z.string().optional(),
  photoCount: z.number().int().nonnegative().optional(),
  faces: z.number().int().nonnegative().optional(),
  persons: z.number().int().nonnegative().optional(),
  embedded: z.number().int().nonnegative().optional(),
  reused: z.number().int().nonnegative().optional(),
  skipped: z.number().int().nonnegative().optional(),
  removed: z.number().int().nonnegative().optional(),
  /** Byte-identical duplicates collapsed during indexing (B6 / FR-2c). */
  duplicates: z.number().int().nonnegative().optional(),
});
export type IndexState = z.infer<typeof IndexStateSchema>;

export const EventSummarySchema = z.object({
  id: z.string(),
  name: z.string().default(''),
  date: z.string().optional(),
  visibility: z.enum(['public', 'link', 'login']).optional(),
  driveFolderId: z.string().optional(),
  /** Distinct photographer/location tags for the event, derived from the
   *  master Sheet's Upload_Links rows by the Drive reconciler (dev plan §8). */
  tags: z.array(z.string()).optional(),
  /** ISO-8601 timestamp of the last "Sync with Drive" reconcile that touched
   *  this event (written by reconcileService). Used to sort the events list. */
  lastSyncedAt: z.string().optional(),
  indexState: IndexStateSchema.optional(),
});
export type EventSummary = z.infer<typeof EventSummarySchema>;

export const ListEventsResponseSchema = z.object({
  ok: z.literal(true),
  events: z.array(EventSummarySchema),
});
export type ListEventsResponse = z.infer<typeof ListEventsResponseSchema>;

export const TriggerIndexRequestSchema = z.object({
  force: z.boolean().optional().default(false),
});
export type TriggerIndexRequest = z.infer<typeof TriggerIndexRequestSchema>;

export const TriggerIndexResponseSchema = z.object({
  ok: z.literal(true),
  eventId: z.string(),
  /** Cloud Run execution resource name, e.g. …/jobs/photo-indexer/executions/xyz */
  execution: z.string(),
});
export type TriggerIndexResponse = z.infer<typeof TriggerIndexResponseSchema>;
