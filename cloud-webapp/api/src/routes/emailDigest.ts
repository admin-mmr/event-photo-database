/**
 * emailDigest.ts — daily digest of admin activity (dev plan G4.1). Cloud
 * Scheduler (or an admin) POSTs this once a day; it summarizes the last 24h of
 * Audit_Log entries and emails opted-in admins (DAILY_REPORT, default OFF).
 *
 * Authorized by allowCronOrAdmin (machine X-Sync-Token or Firebase admin), like
 * the indexing cron. Sending no-ops unless EMAIL_ENABLED='true', so this is safe
 * to wire up before the Gmail scope is live.
 */

import { Router } from 'express';

import { env } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { allowCronOrAdmin } from '../middleware/cronAuth.js';
import { listAudit } from '../services/auditStore.js';
import { optedInAmong } from '../services/emailPrefsStore.js';
import { sendToMany } from '../services/emailService.js';
import { dailyDigest, type DigestLine } from '../services/emailTemplates.js';
import { listUsers } from '../services/userStore.js';

export const emailDigestRouter = Router();

emailDigestRouter.post('/admin/email/daily', allowCronOrAdmin, async (_req, res, next) => {
  try {
    const sid = env.MASTER_SPREADSHEET_ID;
    if (!sid) {
      res.status(503).json({ ok: false, error: 'not_configured', message: 'MASTER_SPREADSHEET_ID is not set' });
      return;
    }
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const records = await listAudit(sid, { since, limit: 500 });
    const lines: DigestLine[] = records.map((r) => ({
      action: r.action,
      resourceId: r.resourceId,
      actorEmail: r.actorEmail,
    }));

    // Active admins are the candidate recipients; digest is opt-in (default OFF).
    const admins = (await listUsers(sid, { status: 'active' }))
      .filter((u) => u.role !== 'api_client')
      .map((u) => u.email);
    const recipients = await optedInAmong(sid, 'dailyReport', admins);

    const sent = await sendToMany(recipients, dailyDigest(lines, since));
    logger.info({ changes: lines.length, recipients: recipients.length, sent }, 'daily digest run');
    res.json({ ok: true, changes: lines.length, recipients: recipients.length, sent });
  } catch (err) {
    next(err);
  }
});
