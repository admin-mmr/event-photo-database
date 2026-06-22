/**
 * partner.ts — programmatic partner API (dev plan G5.3). Authenticated by API
 * key (partnerAuth) + per-client Firestore rate limit. A partner lists events
 * and mints an upload link for THEIR club (reusing the G3 linkStore), then
 * uploads through the standard volunteer pipeline using that link.
 *
 * The partner is pinned to the club on their api_client Users row, so they can
 * never generate a link for another club.
 */

import { Router } from 'express';
import type { PartnerEventsResponse, PartnerLinkResponse } from '@cloud-webapp/shared';
import { PartnerLinkRequestSchema } from '@cloud-webapp/shared';

import { env } from '../lib/config.js';
import { firestore } from '../lib/firestore.js';
import { requirePartner, partnerRateLimit } from '../middleware/partnerAuth.js';
import { recordAudit } from '../services/auditStore.js';
import { generateLink } from '../services/linkStore.js';
import { handleStoreError } from './adminShared.js';

export const partnerRouter = Router();

function uploadUrl(token: string): string {
  const base = env.APP_BASE_URL.replace(/\/$/, '');
  return base ? `${base}/upload/${token}` : `/upload/${token}`;
}

/** GET /api/partner/events — events the partner can target. */
partnerRouter.get('/partner/events', requirePartner, partnerRateLimit(), async (_req, res, next) => {
  try {
    const snap = await firestore().collection('events').get();
    const events = snap.docs.map((d) => ({
      eventId: d.id,
      name: String(d.data().name ?? ''),
      date: String(d.data().date ?? ''),
    }));
    const body: PartnerEventsResponse = { ok: true, events };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

/** POST /api/partner/links — mint (or reuse) an upload link for the partner's club. */
partnerRouter.post('/partner/links', requirePartner, partnerRateLimit(), async (req, res, next) => {
  try {
    const sid = env.MASTER_SPREADSHEET_ID;
    if (!sid) {
      res.status(503).json({ ok: false, error: 'not_configured', message: 'MASTER_SPREADSHEET_ID is not set' });
      return;
    }
    const clubName = req.partner!.clubId;
    if (!clubName) {
      res.status(409).json({ ok: false, error: 'no_club', message: 'This API client has no club assigned' });
      return;
    }
    const { eventId, tag } = PartnerLinkRequestSchema.parse(req.body ?? {});
    const link = await generateLink(sid, { eventId, clubName, tag }, req.partner!.email);
    await recordAudit(sid, {
      actorEmail: req.partner!.email,
      action: 'LINK_GENERATED',
      resourceType: 'link',
      resourceId: link.linkId,
      linkId: link.linkId,
      details: { via: 'partner_api', eventId: link.eventId, clubName: link.clubName, tag: link.tag },
      ip: req.ip ?? '',
    });
    const body: PartnerLinkResponse = {
      ok: true,
      uploadUrl: uploadUrl(link.token),
      token: link.token,
      eventId: link.eventId,
      clubName: link.clubName,
      tag: link.tag,
    };
    res.status(201).json(body);
  } catch (err) {
    if (handleStoreError(err, res)) return;
    next(err);
  }
});
