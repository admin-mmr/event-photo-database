/**
 * linkHandlers.ts — google.script.run handlers for upload link management.
 *
 * Covers: serverGenerateLink, serverRevokeLink, serverRotateLink, serverListLinks.
 */

import { ResultStatus, UserRole } from '../types/enums';
import { ServerResponse, WithSession } from '../types/responses';
import { requireAdminOrFail } from '../middleware/authMiddleware';
import {
  generateLink,
  revokeLink,
  rotateLink,
  findByEvent,
  findByClub,
  listAll as listAllLinks,
} from '../services/uploadLinkService';
import { appendAuditLog } from '../services/auditLogService';
import { AuditAction } from '../types/enums';

/* global Logger */

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function serverGenerateLink(
  payload: WithSession<{ eventId: string; clubName: string; tag?: string }>
): ServerResponse {
  try {
    const auth = requireAdminOrFail(payload?.sessionToken);
    if (!auth.ok) return auth.response;
    const { eventId, clubName } = payload;
    const tag = (payload.tag ?? '').trim();
    if (!eventId || !clubName) {
      return { status: 'error', message: 'eventId and clubName are required' };
    }
    if (auth.adminRole === UserRole.CLUB_ADMIN && auth.adminClubId !== clubName) {
      return {
        status: 'error',
        message: `You are the admin for "${auth.adminClubId}" and cannot generate links for "${clubName}".`,
      };
    }
    const result = generateLink({ eventId, clubName, tag }, auth.adminEmail);
    if (result.status === ResultStatus.SUCCESS && result.data) {
      appendAuditLog({
        actorEmail: auth.adminEmail, action: AuditAction.LINK_GENERATED,
        resourceType: 'link', resourceId: result.data.linkId,
        details: { eventId, clubName, tag, linkId: result.data.linkId, version: result.data.version },
      });
    }
    return { status: result.status, message: result.message, data: result.data };
  } catch (err) {
    Logger.log(`serverGenerateLink error: ${String(err)}`);
    return { status: 'error', message: 'Internal error generating link' };
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function serverRevokeLink(
  payload: WithSession<{ linkId: string; reason?: string }>
): ServerResponse {
  try {
    const auth = requireAdminOrFail(payload?.sessionToken);
    if (!auth.ok) return auth.response;
    if (!payload.linkId) return { status: 'error', message: 'linkId is required' };
    const result = revokeLink({ linkId: payload.linkId, reason: payload.reason }, auth.adminEmail);
    if (result.status === ResultStatus.SUCCESS && result.data) {
      const link = result.data;
      if (auth.adminRole === UserRole.CLUB_ADMIN && auth.adminClubId !== link.clubName) {
        return {
          status: 'error',
          message: `You are the admin for "${auth.adminClubId}" and cannot revoke links for "${link.clubName}".`,
        };
      }
      appendAuditLog({
        actorEmail: auth.adminEmail, action: AuditAction.LINK_REVOKED,
        resourceType: 'link', resourceId: link.linkId,
        details: { eventId: link.eventId, clubName: link.clubName, linkId: link.linkId, reason: payload.reason ?? '' },
      });
    }
    return { status: result.status, message: result.message, data: result.data };
  } catch (err) {
    Logger.log(`serverRevokeLink error: ${String(err)}`);
    return { status: 'error', message: 'Internal error revoking link' };
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function serverRotateLink(
  payload: WithSession<{ linkId: string; reason?: string }>
): ServerResponse {
  try {
    const auth = requireAdminOrFail(payload?.sessionToken);
    if (!auth.ok) return auth.response;
    if (!payload.linkId) return { status: 'error', message: 'linkId is required' };
    const result = rotateLink(payload.linkId, auth.adminEmail, payload.reason);
    if (result.status === ResultStatus.SUCCESS && result.data) {
      appendAuditLog({
        actorEmail: auth.adminEmail, action: AuditAction.LINK_REVOKED,
        resourceType: 'link', resourceId: payload.linkId,
        details: { operation: 'rotate', oldLinkId: payload.linkId, newLinkId: result.data.linkId, version: result.data.version, reason: payload.reason ?? 'Rotated' },
      });
      appendAuditLog({
        actorEmail: auth.adminEmail, action: AuditAction.LINK_GENERATED,
        resourceType: 'link', resourceId: result.data.linkId,
        details: { operation: 'rotate', newLinkId: result.data.linkId, version: result.data.version, eventId: result.data.eventId, clubName: result.data.clubName },
      });
    }
    return { status: result.status, message: result.message, data: result.data };
  } catch (err) {
    Logger.log(`serverRotateLink error: ${String(err)}`);
    return { status: 'error', message: 'Internal error rotating link' };
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function serverListLinks(
  payload: WithSession<{ eventId?: string; clubName?: string }>
): ServerResponse {
  try {
    const auth = requireAdminOrFail(payload?.sessionToken);
    if (!auth.ok) return auth.response;
    let links;
    if (auth.adminRole === UserRole.CLUB_ADMIN) {
      links = findByClub(auth.adminClubId);
    } else if (payload.eventId) {
      links = findByEvent(payload.eventId);
      if (payload.clubName) links = links.filter((l) => l.clubName === payload.clubName);
    } else if (payload.clubName) {
      links = findByClub(payload.clubName);
    } else {
      links = listAllLinks();
    }
    return {
      status: 'success',
      message: `Found ${links.length} link(s)`,
      data: { items: links, total: links.length },
    };
  } catch (err) {
    Logger.log(`serverListLinks error: ${String(err)}`);
    return { status: 'error', message: 'Internal error listing links' };
  }
}
