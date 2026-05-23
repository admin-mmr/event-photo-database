import { z } from 'zod';

export const HealthResponseSchema = z.object({
  ok: z.literal(true),
  version: z.string(),
  uptimeSec: z.number().nonnegative(),
  commit: z.string().nullable(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
