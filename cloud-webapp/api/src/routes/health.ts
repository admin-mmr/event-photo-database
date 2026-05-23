import { Router } from 'express';
import type { HealthResponse } from '@cloud-webapp/shared';
import { env } from '../lib/config.js';

const startedAt = Date.now();

export const healthRouter = Router();

/**
 * GET /api/health
 * Liveness + build identification. Never auth-gated; Cloud Run's startup
 * probe and Uptime Checks both hit this.
 */
healthRouter.get('/health', (_req, res) => {
  const body: HealthResponse = {
    ok: true,
    version: '0.1.0',
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    commit: env.GIT_COMMIT_SHA ?? null,
  };
  res.json(body);
});
