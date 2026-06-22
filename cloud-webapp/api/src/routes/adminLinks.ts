/**
 * adminLinks.ts — volunteer upload-link admin API (dev plan G3.2). Writes go to
 * the Upload_Links tab (SSOT) through linkStore; every action is audited.
 *
 * RBAC: any admin manages links, but a club_admin (or a super_admin masquerading
 * via X-Masquerade-Club) is scoped to their own club — they can only list,
 * generate, revoke, and rotate links whose clubName matches their scope. A
 * super_admin with no masquerade manages every club.
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  GenerateLinkRequestSchema,
  RevokeLinkRequestSchema,
  type LinkResponse,
  type ListLinksResponse,
} from '@cloud-webapp/shared';

import { requireAuth } from '../middleware/auth.js';
import { attachRole, requireAnyAdmin } from '../middleware/rbac.js';
import { recordAudit } from '../services/auditStore.js';
import { generateLink, listLinks, revokeLink, rotateLink } from '../services/linkStore.js';
import { actor, effectiveClubScope, handleStoreError, masterSheetId } from './adminShared.js';

export const adminLinksRouter = Router();

/** 403 unless `clubName` is within the caller's effective scope. Returns true if denied. */
function denyOutOfScope(req: Request, res: Response, clubName: string): boolean {
  const scope = effectiveClubScope(req); // undefined = all (super_admin, no masquerade)
  if (scope !== undefined && clubName !== scope) {
    res.status(403).json({ ok: false, error: 'forbidden', message: 'Outside your club scope' });
    return true;
  }
  return false;
}

/** GET /api/admin/links?eventId&clubName&status — scoped to the caller's club. */
adminLinksRouter.get('/admin/links', requireAuth, attachRole, requireAnyAdmin, async (req, res, next) => {
  try {
    const sid = masterSheetId(res);
    if (!sid) return;
    const scope = effectiveClubScope(req);
    const filter: { eventId?: string; clubName?: string } = {};
    if (typeof req.query.eventId === 'string' && req.query.eventId) filter.eventId = req.query.eventId;
    // A scoped caller is pinned to their club regardless of any clubName query.
    if (scope !== undefined) filter.clubName = scope;
    else if (typeof req.query.clubName === 'string' && req.query.clubName) filter.clubName = req.query.clubName;

    const links = await listLinks(sid, filter);
    const body: ListLinksResponse = { ok: true, links };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

/** POST /api/admin/links — generate (idempotent per event,club,tag). */
adminLinksRouter.post('/admin/links', requireAuth, attachRole, requireAnyAdmin, async (req, res, next) => {
  try {
    const sid = masterSheetId(res);
    if (!sid) return;
    const input = GenerateLinkRequestSchema.parse(req.body ?? {});
    if (denyOutOfScope(req, res, input.clubName.trim())) return;
    const link = await generateLink(sid, input, actor(req));
    await recordAudit(sid, {
      actorEmail: actor(req),
      action: 'LINK_GENERATED',
      resourceType: 'link',
      resourceId: link.linkId,
      linkId: link.linkId,
      details: { eventId: link.eventId, clubName: link.clubName, tag: link.tag, version: link.version },
      ip: req.ip ?? '',
    });
    const body: LinkResponse = { ok: true, link };
    res.status(201).json(body);
  } catch (err) {
    if (handleStoreError(err, res)) return;
    next(err);
  }
});

/** Locate a link by id for a scope check; 404 if unknown. */
async function findForScope(sid: string, linkId: string): Promise<{ clubName: string } | null> {
  const links = await listLinks(sid);
  const hit = links.find((l) => l.linkId === linkId);
  return hit ? { clubName: hit.clubName } : null;
}

/** POST /api/admin/links/:linkId/revoke */
adminLinksRouter.post('/admin/links/:linkId/revoke', requireAuth, attachRole, requireAnyAdmin, async (req, res, next) => {
  try {
    const sid = masterSheetId(res);
    if (!sid) return;
    const linkId = String(req.params.linkId);
    const found = await findForScope(sid, linkId);
    if (!found) {
      res.status(404).json({ ok: false, error: 'not_found', message: `Link not found: ${linkId}` });
      return;
    }
    if (denyOutOfScope(req, res, found.clubName)) return;
    const { reason } = RevokeLinkRequestSchema.parse(req.body ?? {});
    const link = await revokeLink(sid, linkId, reason ?? '', actor(req));
    await recordAudit(sid, {
      actorEmail: actor(req),
      action: 'LINK_REVOKED',
      resourceType: 'link',
      resourceId: link.linkId,
      linkId: link.linkId,
      reason: link.revokedReason,
      ip: req.ip ?? '',
    });
    const body: LinkResponse = { ok: true, link };
    res.json(body);
  } catch (err) {
    if (handleStoreError(err, res)) return;
    next(err);
  }
});

/** POST /api/admin/links/:linkId/rotate */
adminLinksRouter.post('/admin/links/:linkId/rotate', requireAuth, attachRole, requireAnyAdmin, async (req, res, next) => {
  try {
    const sid = masterSheetId(res);
    if (!sid) return;
    const linkId = String(req.params.linkId);
    const found = await findForScope(sid, linkId);
    if (!found) {
      res.status(404).json({ ok: false, error: 'not_found', message: `Link not found: ${linkId}` });
      return;
    }
    if (denyOutOfScope(req, res, found.clubName)) return;
    const link = await rotateLink(sid, linkId, actor(req));
    await recordAudit(sid, {
      actorEmail: actor(req),
      action: 'LINK_ROTATED',
      resourceType: 'link',
      resourceId: link.linkId,
      linkId: link.linkId,
      details: { version: link.version, eventId: link.eventId, clubName: link.clubName },
      ip: req.ip ?? '',
    });
    const body: LinkResponse = { ok: true, link };
    res.json(body);
  } catch (err) {
    if (handleStoreError(err, res)) return;
    next(err);
  }
});
