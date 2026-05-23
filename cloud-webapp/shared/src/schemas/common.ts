import { z } from 'zod';

/**
 * Standard error envelope returned by every api endpoint on failure.
 * Mirrors the shape used by gas-app for migration parity.
 */
export const ApiErrorSchema = z.object({
  ok: z.literal(false),
  error: z.string(),
  message: z.string(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;
