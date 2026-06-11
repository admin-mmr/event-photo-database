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

  // ── Find Me / indexing (dev plan M1) ──────────────────────────────────
  // Region + job name for the photo-indexer Cloud Run Job.
  GCP_REGION: z.string().default('us-central1'),
  INDEXER_JOB_NAME: z.string().default('photo-indexer'),

  // Admin allowlist for the "Index event" trigger (comma-separated emails).
  ADMIN_EMAILS: z.string().default('admin@mmrunners.org'),

  // Keyless DWD for Drive reads (runbook §G1): the DWD-enabled SA we sign
  // JWTs for, and the Workspace user it impersonates.
  DWD_SA: z.string().default('indexer-runtime@mmr-data-pipeline.iam.gserviceaccount.com'),
  DWD_SUBJECT: z.string().default('admin@mmrunners.org'),
});

export type Env = z.infer<typeof EnvSchema>;

export const env: Env = EnvSchema.parse(process.env);

export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
