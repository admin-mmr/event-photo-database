/**
 * adminVerdicts.ts — admin-only, audited review of the verdicts users marked.
 *
 *   GET /api/admin/verdict-batches          recent batches (one per search run)
 *   GET /api/admin/verdict-batches/:runId   one batch: selfie + every verdict
 *
 * The flat queue (routes/feedback.ts) lists votes; this groups them the way they
 * were actually produced — one Find Me search, one selfie, all the me/not-me
 * calls the searcher made on its results — so an admin can see at a glance
 * whether the matcher got that search right.
 *
 * Both routes surface another user's reference selfie, so they carry the same
 * guarantees as adminFindme.ts: requireAuth + admin role, and an `admin_audit`
 * record (+ log line) written BEFORE returning. Read-only — nothing here writes
 * to match_feedback / match_runs, so the eval feedback loop is untouched.
 */

import { Router } from 'express';
import type { AdminVerdictBatchListResponse, AdminVerdictBatchResponse } from '@cloud-webapp/shared';

import { requireAuth } from '../middleware/auth.js';
import { attachRole, requireAnyAdmin } from '../middleware/rbac.js';
import { recordAdminAudit } from '../services/adminAudit.js';
import {
  getVerdictBatch,
  listVerdictBatches,
  type VerdictBatchFilter,
} from '../services/verdictBatchService.js';

export const adminVerdictsRouter = Router();

const LIST_DEFAULT = 25;

adminVerdictsRouter.get(
  '/admin/verdict-batches',
  requireAuth,
  attachRole,
  requireAnyAdmin,
  async (req, res, next) => {
    try {
      const str = (v: unknown): string | undefined =>
        typeof v === 'string' && v.trim() ? v.trim() : undefined;
      const limitRaw = Number.parseInt(String(req.query.limit ?? LIST_DEFAULT), 10);
      const eventId = str(req.query.eventId);
      const uid = str(req.query.uid);
      const email = str(req.query.email);
      const filter: VerdictBatchFilter = {
        ...(Number.isFinite(limitRaw) ? { limit: limitRaw } : {}),
        ...(eventId ? { eventId } : {}),
        ...(uid ? { uid } : {}),
        ...(email ? { email } : {}),
      };

      const { batches, unattributed, capped } = await listVerdictBatches(filter);

      await recordAdminAudit({
        adminUid: req.user!.uid,
        adminEmail: req.user!.email ?? null,
        action: 'verdict_batch_list',
        ...(eventId ? { eventId } : {}),
        details: { filter, count: batches.length, unattributed, capped },
      });

      const body: AdminVerdictBatchListResponse = {
        ok: true,
        total: batches.length,
        unattributed,
        capped,
        batches,
      };
      res.json(body);
    } catch (err) {
      next(err);
    }
  },
);

adminVerdictsRouter.get(
  '/admin/verdict-batches/:runId',
  requireAuth,
  attachRole,
  requireAnyAdmin,
  async (req, res, next) => {
    try {
      const runId = String(req.params.runId);
      const batch = await getVerdictBatch(runId);
      if (!batch) {
        res.status(404).json({
          ok: false,
          error: 'not_found',
          message: 'No verdicts recorded for that search (it may have been erased).',
        });
        return;
      }

      await recordAdminAudit({
        adminUid: req.user!.uid,
        adminEmail: req.user!.email ?? null,
        action: 'verdict_batch_view',
        uploadId: batch.selfieUploadId,
        targetUid: batch.uid,
        eventId: batch.eventId,
        details: { runId, counts: batch.counts, votes: batch.votes.length },
      });

      const body: AdminVerdictBatchResponse = { ok: true, batch };
      res.json(body);
    } catch (err) {
      next(err);
    }
  },
);
