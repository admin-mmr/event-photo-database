import { z } from 'zod';

/**
 * Environment configuration. Validated once at startup so misconfiguration
 * fails fast instead of leaking out as a confusing 500 hours later.
 *
 * For local dev, copy `api/.env.example` to `api/.env` and fill in values.
 * In production (Cloud Run) these come from `--set-env-vars` and
 * `--set-secrets` flags in `infra/scripts/deploy-api.sh`.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),

  // GCP project this Cloud Run service runs in. Used to construct
  // Firestore/Storage client config. On Cloud Run this is auto-detected
  // from the metadata server, so it's optional in production.
  GCP_PROJECT_ID: z.string().optional(),

  // Firebase Auth project. Usually the same as GCP_PROJECT_ID.
  FIREBASE_PROJECT_ID: z.string().optional(),

  // Set by Cloud Build / GitHub Actions to the commit SHA so /api/health
  // can return a build identifier.
  GIT_COMMIT_SHA: z.string().optional(),

  // Comma-separated list of CORS origins allowed in non-production.
  // In production, traffic comes from the same origin via Firebase Hosting
  // rewrite, so CORS is unnecessary.
  CORS_ORIGINS: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

export const env: Env = EnvSchema.parse(process.env);

export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
