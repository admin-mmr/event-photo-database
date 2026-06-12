import { z } from 'zod';

/**
 * Find Me contracts (dev plan M2; PRD §5, §7). Demo fast-path scope
 * (2026-06-12): search + gallery only — feedback, enrollment, and the
 * minor/guardian consent flow land with M3/M4.
 */

// ── Gallery (GET /api/events/:id/photos) ─────────────────────────────────────

export const GalleryPhotoSchema = z.object({
  photoId: z.string(),
  name: z.string().default(''),
  /** Short-lived V4 signed URLs into the derivatives bucket. */
  thumbUrl: z.string(),
  webUrl: z.string(),
});
export type GalleryPhoto = z.infer<typeof GalleryPhotoSchema>;

export const ListPhotosResponseSchema = z.object({
  ok: z.literal(true),
  eventId: z.string(),
  photos: z.array(GalleryPhotoSchema),
});
export type ListPhotosResponse = z.infer<typeof ListPhotosResponseSchema>;

// ── Search (POST /api/findme/search, multipart) ──────────────────────────────

export const MatchResultSchema = z.object({
  photoId: z.string(),
  /** Fused score (or single-signal score in face/person mode). */
  score: z.number(),
  faceScore: z.number().nullable(),
  personScore: z.number().nullable(),
  thumbUrl: z.string(),
  webUrl: z.string(),
});
export type MatchResult = z.infer<typeof MatchResultSchema>;

export const SearchResponseSchema = z.object({
  ok: z.literal(true),
  eventId: z.string(),
  mode: z.enum(['fused', 'face', 'person']),
  modelVersion: z.string().optional(),
  /** ID of the persisted match_runs doc (feeds the M4 feedback loop). */
  runId: z.string().optional(),
  results: z.array(MatchResultSchema),
});
export type SearchResponse = z.infer<typeof SearchResponseSchema>;

/** 422 from the matcher when the reference photo has no usable face. */
export const NoUsableFaceResponseSchema = z.object({
  ok: z.literal(false),
  error: z.literal('no_usable_face'),
  message: z.string(),
});
export type NoUsableFaceResponse = z.infer<typeof NoUsableFaceResponseSchema>;
