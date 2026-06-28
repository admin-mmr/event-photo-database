/**
 * metrics.ts — GET /api/admin/metrics (dev plan M6.2; PRD §2).
 *
 * An admin-only roll-up of the success metrics that can be computed straight
 * from Firestore: search volume, distinct searchers, consent coverage, the
 * feedback-based judged-precision proxy, and erasure activity, over a recent
 * window (default 90 days, optionally scoped to one event).
 *
 * We read each collection ordered by `createdAt desc` with a hard cap and
 * aggregate in memory — no composite index, fine at pilot scale. Metrics that
 * are not derivable from stored data (p95 latency, $ spend, recall, volunteer
 * deflection) are intentionally absent; see `docs/FINDME_RUNBOOK.md` §Metrics.
 */

import { Router } from 'express';
import type { Query, DocumentData } from '@google-cloud/firestore';
import type { AdminMetricsResponse } from '@cloud-webapp/shared';

import { firestore } from '../lib/firestore.js';
import { env } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { requireAuth } from '../middleware/auth.js';
import { attachRole, requireAnyAdmin } from '../middleware/rbac.js';
import { listClubs } from '../services/clubStore.js';
import { listUsers } from '../services/userStore.js';

export const metricsRouter = Router();

/** Per-collection fetch cap — generous for a single-event pilot. */
const SCAN_LIMIT = 5000;
const DEFAULT_SINCE_DAYS = 90;
const MAX_SINCE_DAYS = 365;

/**
 * Current control-plane totals (not windowed). Events + indexed photos are cheap
 * `count()` aggregations on Firestore; users + clubs come from the master Sheet
 * (SSOT). Best-effort — any source failing degrades that count to null/0 rather
 * than failing the whole metrics call.
 */
async function platformCounts(): Promise<{
  events: number;
  photos: number;
  users: number | null;
  activeUsers: number | null;
  clubs: number | null;
}> {
  const countOf = async (collection: string): Promise<number> => {
    try {
      const agg = await firestore().collection(collection).count().get();
      return Number(agg.data().count ?? 0);
    } catch (err) {
      logger.warn({ err, collection }, 'metrics count() failed (non-fatal)');
      return 0;
    }
  };
  const [events, photos] = await Promise.all([countOf('events'), countOf('photos')]);

  let users: number | null = null;
  let activeUsers: number | null = null;
  let clubs: number | null = null;
  if (env.MASTER_SPREADSHEET_ID) {
    try {
      const all = await listUsers(env.MASTER_SPREADSHEET_ID);
      users = all.length;
      activeUsers = all.filter((u) => u.status === 'active').length;
    } catch (err) {
      logger.warn({ err }, 'metrics user count failed (non-fatal)');
    }
    try {
      clubs = (await listClubs(env.MASTER_SPREADSHEET_ID, { status: 'active' })).length;
    } catch (err) {
      logger.warn({ err }, 'metrics club count failed (non-fatal)');
    }
  }
  return { events, photos, users, activeUsers, clubs };
}

async function recentDocs(collection: string, since: string): Promise<DocumentData[]> {
  const query: Query<DocumentData> = firestore()
    .collection(collection)
    .orderBy('createdAt', 'desc')
    .limit(SCAN_LIMIT);
  const snap = await query.get();
  return snap.docs.map((d) => d.data()).filter((d) => String(d.createdAt ?? '') >= since);
}

metricsRouter.get('/admin/metrics', requireAuth, attachRole, requireAnyAdmin, async (req, res, next) => {
  try {
    const eventId =
      typeof req.query.eventId === 'string' && req.query.eventId ? req.query.eventId : undefined;
    const sinceDaysRaw = Number.parseInt(String(req.query.sinceDays ?? DEFAULT_SINCE_DAYS), 10);
    const sinceDays = Math.min(
      Math.max(Number.isFinite(sinceDaysRaw) ? sinceDaysRaw : DEFAULT_SINCE_DAYS, 1),
      MAX_SINCE_DAYS,
    );
    const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString();

    const [runs, consents, feedback] = await Promise.all([
      recentDocs('match_runs', since),
      recentDocs('consents', since),
      recentDocs('match_feedback', since),
    ]);

    const byEvent = (d: DocumentData): boolean => !eventId || String(d.eventId ?? '') === eventId;

    const runsScoped = runs.filter(byEvent);
    const searches = runsScoped.length;
    const distinctSearchers = new Set(runsScoped.map((d) => String(d.uid ?? ''))).size;
    const searchesByMode = {
      fused: runsScoped.filter((d) => d.mode !== 'person').length,
      person: runsScoped.filter((d) => d.mode === 'person').length,
    };

    const searchConsents = consents.filter(
      (d) => d.action === 'findme_search' && byEvent(d),
    );
    const minorSearches = searchConsents.filter((d) => d.subjectIsMinor === true).length;
    const consentRecords = searchConsents.length;
    const coverage = searches === 0 ? 1 : Math.min(1, consentRecords / searches);

    // `data_deleted` audit docs are user-scoped (no eventId), so they are not
    // narrowed by the eventId filter.
    const dataDeletions = consents.filter((d) => d.action === 'data_deleted').length;

    const fbScoped = feedback.filter(byEvent);
    const confirmed = fbScoped.filter((d) => d.verdict === 'confirmed').length;
    const not_me = fbScoped.filter((d) => d.verdict === 'not_me').length;
    const precision = confirmed + not_me === 0 ? null : confirmed / (confirmed + not_me);

    const platform = await platformCounts();

    const body: AdminMetricsResponse = {
      ok: true,
      window: { sinceDays, since, eventId: eventId ?? null },
      searches,
      distinctSearchers,
      searchesByMode,
      minorSearches,
      consent: { records: consentRecords, coverage },
      feedback: { confirmed, not_me, precision },
      dataDeletions,
      platform,
    };
    res.json(body);
  } catch (err) {
    next(err);
  }
});
