/**
 * linkHandlers.ts — google.script.run handlers for upload link management.
 *
 * Covers: serverGenerateLink, serverRevokeLink, serverRotateLink, serverListLinks.
 */

import { ResultStatus, UserRole } from '../types/enums';
import { ServerResponse, WithSession } from '../types/responses';
import { requireAdminOrFail } from '../middleware/authMiddleware';
import { DEFAULT_TAG } from '../config/constants';
import {
  generateLink,
  revokeLink,
  rotateLink,
  findByEvent,
  findByClub,
  listAll as listAllLinks,
} from '../services/uploadLinkService';
import { appendAuditLog, appendAuditFailure } from '../services/auditLogService';
import { AuditAction } from '../types/enums';

/* global Logger */

/** Returns the keys of the payload, with credential keys masked. */
function payloadKeys(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '(empty)';
  return Object.keys(payload as Record<string, unknown>).join(',');
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function serverGenerateLink(
  payload: WithSession<{ eventId: string; clubName: string; tag?: string }>
): ServerResponse {
  Logger.log(`[serverGenerateLink] entry — payload keys=[${payloadKeys(payload)}]`);
  try {
    const auth = requireAdminOrFail(payload?.sessionToken);
    if (!auth.ok) {
      Logger.log(`[serverGenerateLink] auth rejected — sessionToken present=${!!payload?.sessionToken}`);
      appendAuditFailure({
        actorEmail:   '',
        action:       AuditAction.ADMIN_AUTH_REJECTED,
        resourceType: 'link',
        stage:        'auth',
        message:      auth.response?.message,
        attemptedPayload: payload as unknown as Record<string, unknown>,
      });
      return auth.response;
    }
    Logger.log(`[serverGenerateLink] authenticated as ${auth.adminEmail} (role=${auth.adminRole})`);

    const { eventId, clubName } = payload;
    const tag = (payload.tag ?? '').trim() || DEFAULT_TAG;
    if (!eventId || !clubName) {
      Logger.log(`[serverGenerateLink] missing required fields — eventId="${eventId}" clubName="${clubName}"`);
      appendAuditFailure({
        actorEmail:   auth.adminEmail,
        action:       AuditAction.LINK_GENERATE_FAILED,
        resourceType: 'link',
        stage:        'payload_validation',
        message:      'eventId and clubName are required',
        attemptedPayload: payload as unknown as Record<string, unknown>,
      });
      return { status: 'error', message: 'eventId and clubName are required' };
    }
    if (auth.adminRole === UserRole.CLUB_ADMIN && auth.adminClubId !== clubName) {
      Logger.log(
        `[serverGenerateLink] authorization rejected — actor=${auth.adminEmail} ` +
        `actorClub=${auth.adminClubId} requestedClub=${clubName}`
      );
      appendAuditFailure({
        actorEmail:   auth.adminEmail,
        action:       AuditAction.LINK_GENERATE_FAILED,
        resourceType: 'link',
        stage:        'authorization',
        message:      `Cross-club access denied (actorClub=${auth.adminClubId}, requestedClub=${clubName})`,
        attemptedPayload: payload as unknown as Record<string, unknown>,
      });
      return {
        status: 'error',
        message: `You are the admin for "${auth.adminClubId}" and cannot generate links for "${clubName}".`,
      };
    }
    const result = generateLink({ eventId, clubName, tag }, auth.adminEmail);
    if (result.status !== ResultStatus.SUCCESS || !result.data) {
      Logger.log(`[serverGenerateLink] service failed — actor=${auth.adminEmail} eventId=${eventId} clubName=${clubName} message="${result.message}"`);
      appendAuditFailure({
        actorEmail:   auth.adminEmail,
        action:       AuditAction.LINK_GENERATE_FAILED,
        resourceType: 'link',
        stage:        'service_layer',
        message:      result.message,
        attemptedPayload: payload as unknown as Record<string, unknown>,
      });
      return { status: result.status, message: result.message, data: result.data };
    }
    appendAuditLog({
      actorEmail: auth.adminEmail, action: AuditAction.LINK_GENERATED,
      resourceType: 'link', resourceId: result.data.linkId,
      details: { eventId, clubName, tag, linkId: result.data.linkId, version: result.data.version },
    });
    Logger.log(`[serverGenerateLink] success — linkId=${result.data.linkId} actor=${auth.adminEmail}`);
    return { status: result.status, message: result.message, data: result.data };
  } catch (err) {
    Logger.log(`[serverGenerateLink] unhandled exception: ${String(err)}`);
    appendAuditFailure({
      actorEmail:   '',
      action:       AuditAction.LINK_GENERATE_FAILED,
      resourceType: 'link',
      stage:        'unhandled_exception',
      message:      String(err),
      attemptedPayload: payload as unknown as Record<string, unknown>,
    });
    return { status: 'error', message: 'Internal error generating link' };
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function serverRevokeLink(
  payload: WithSession<{ linkId: string; reason?: string }>
): ServerResponse {
  Logger.log(`[serverRevokeLink] entry — payload keys=[${payloadKeys(payload)}]`);
  try {
    const auth = requireAdminOrFail(payload?.sessionToken);
    if (!auth.ok) {
      Logger.log(`[serverRevokeLink] auth rejected`);
      appendAuditFailure({
        actorEmail:   '',
        action:       AuditAction.ADMIN_AUTH_REJECTED,
        resourceType: 'link',
        stage:        'auth',
        message:      auth.response?.message,
        attemptedPayload: payload as unknown as Record<string, unknown>,
      });
      return auth.response;
    }
    Logger.log(`[serverRevokeLink] authenticated as ${auth.adminEmail} (role=${auth.adminRole})`);

    if (!payload.linkId) {
      Logger.log(`[serverRevokeLink] missing linkId — actor=${auth.adminEmail}`);
      appendAuditFailure({
        actorEmail:   auth.adminEmail,
        action:       AuditAction.LINK_REVOKE_FAILED,
        resourceType: 'link',
        stage:        'payload_validation',
        message:      'linkId is required',
        attemptedPayload: payload as unknown as Record<string, unknown>,
      });
      return { status: 'error', message: 'linkId is required' };
    }
    const result = revokeLink({ linkId: payload.linkId, reason: payload.reason }, auth.adminEmail);
    if (result.status !== ResultStatus.SUCCESS || !result.data) {
      Logger.log(`[serverRevokeLink] service failed — actor=${auth.adminEmail} linkId=${payload.linkId} message="${result.message}"`);
      appendAuditFailure({
        actorEmail:   auth.adminEmail,
        action:       AuditAction.LINK_REVOKE_FAILED,
        resourceType: 'link',
        resourceId:   payload.linkId,
        stage:        'service_layer',
        message:      result.message,
        reason:       payload.reason,
        attemptedPayload: payload as unknown as Record<string, unknown>,
      });
      return { status: result.status, message: result.message, data: result.data };
    }
    const link = result.data;
    if (auth.adminRole === UserRole.CLUB_ADMIN && auth.adminClubId !== link.clubName) {
      Logger.log(
        `[serverRevokeLink] authorization rejected — actor=${auth.adminEmail} ` +
        `actorClub=${auth.adminClubId} linkClub=${link.clubName}`
      );
      appendAuditFailure({
        actorEmail:   auth.adminEmail,
        action:       AuditAction.LINK_REVOKE_FAILED,
        resourceType: 'link',
        resourceId:   link.linkId,
        stage:        'authorization',
        message:      `Cross-club access denied (actorClub=${auth.adminClubId}, linkClub=${link.clubName})`,
        attemptedPayload: payload as unknown as Record<string, unknown>,
      });
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
    Logger.log(`[serverRevokeLink] success — linkId=${link.linkId} actor=${auth.adminEmail}`);
    return { status: result.status, message: result.message, data: result.data };
  } catch (err) {
    Logger.log(`[serverRevokeLink] unhandled exception: ${String(err)}`);
    appendAuditFailure({
      actorEmail:   '',
      action:       AuditAction.LINK_REVOKE_FAILED,
      resourceType: 'link',
      stage:        'unhandled_exception',
      message:      String(err),
      attemptedPayload: payload as unknown as Record<string, unknown>,
    });
    return { status: 'error', message: 'Internal error revoking link' };
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function serverRotateLink(
  payload: WithSession<{ linkId: string; reason?: string }>
): ServerResponse {
  Logger.log(`[serverRotateLink] entry — payload keys=[${payloadKeys(payload)}]`);
  try {
    const auth = requireAdminOrFail(payload?.sessionToken);
    if (!auth.ok) {
      Logger.log(`[serverRotateLink] auth rejected`);
      appendAuditFailure({
        actorEmail:   '',
        action:       AuditAction.ADMIN_AUTH_REJECTED,
        resourceType: 'link',
        stage:        'auth',
        message:      auth.response?.message,
        attemptedPayload: payload as unknown as Record<string, unknown>,
      });
      return auth.response;
    }
    Logger.log(`[serverRotateLink] authenticated as ${auth.adminEmail} (role=${auth.adminRole})`);

    if (!payload.linkId) {
      Logger.log(`[serverRotateLink] missing linkId — actor=${auth.adminEmail}`);
      appendAuditFailure({
        actorEmail:   auth.adminEmail,
        action:       AuditAction.LINK_ROTATE_FAILED,
        resourceType: 'link',
        stage:        'payload_validation',
        message:      'linkId is required',
        attemptedPayload: payload as unknown as Record<string, unknown>,
      });
      return { status: 'error', message: 'linkId is required' };
    }
    const result = rotateLink(payload.linkId, auth.adminEmail, payload.reason);
    if (result.status !== ResultStatus.SUCCESS || !result.data) {
      Logger.log(`[serverRotateLink] service failed — actor=${auth.adminEmail} linkId=${payload.linkId} message="${result.message}"`);
      appendAuditFailure({
        actorEmail:   auth.adminEmail,
        action:       AuditAction.LINK_ROTATE_FAILED,
        resourceType: 'link',
        resourceId:   payload.linkId,
        stage:        'service_layer',
        message:      result.message,
        reason:       payload.reason,
        attemptedPayload: payload as unknown as Record<string, unknown>,
      });
      return { status: result.status, message: result.message, data: result.data };
    }
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
    Logger.log(`[serverRotateLink] success — oldLinkId=${payload.linkId} newLinkId=${result.data.linkId} actor=${auth.adminEmail}`);
    return { status: result.status, message: result.message, data: result.data };
  } catch (err) {
    Logger.log(`[serverRotateLink] unhandled exception: ${String(err)}`);
    appendAuditFailure({
      actorEmail:   '',
      action:       AuditAction.LINK_ROTATE_FAILED,
      resourceType: 'link',
      stage:        'unhandled_exception',
      message:      String(err),
      attemptedPayload: payload as unknown as Record<string, unknown>,
    });
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
