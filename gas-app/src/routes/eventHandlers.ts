/**
 * eventHandlers.ts — google.script.run handlers for events and clubs.
 *
 * Covers: serverCreateEvent, serverUpdateEvent, serverListEvents,
 *         serverScanViolations, serverListClubs, serverCreateClub,
 *         serverUpdateClub, serverDeactivateClub, serverReactivateClub.
 */

import { ResultStatus } from '../types/enums';
import { ServerResponse, WithSession } from '../types/responses';
import { requireAdminOrFail, authenticateRequest } from '../middleware/authMiddleware';
import {
  sanitizePayload,
  sanitizeString,
  validateCreateEventPayload,
  validateUpdateEventPayload,
  validateCreateClubPayload,
  validateUpdateClubPayload,
  requireString,
} from '../middleware/inputValidator';
import {
  createEvent,
  updateEvent,
  listAll as listAllEvents,
} from '../services/eventService';
import {
  createClub,
  updateClub,
  deactivateClub,
  reactivateClub,
  listAll as listAllClubs,
  listActive as listActiveClubs,
} from '../services/clubService';
import { scanAllViolations } from '../services/driveService';
import { appendAuditLog, appendAuditFailure } from '../services/auditLogService';
import { notifyEventCreated } from '../services/emailService';
import { triggerMetadataSync } from '../services/indexTriggerClient';
import { AuditAction } from '../types/enums';

/* global Logger */

/** Returns the keys of the payload, with credential keys masked. */
function payloadKeys(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '(empty)';
  return Object.keys(payload as Record<string, unknown>).join(',');
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function serverCreateEvent(payload: WithSession): ServerResponse {
  Logger.log(`[serverCreateEvent] entry — payload keys=[${payloadKeys(payload)}]`);
  try {
    const auth = requireAdminOrFail(payload?.sessionToken);
    if (!auth.ok) {
      Logger.log(`[serverCreateEvent] auth rejected — sessionToken present=${!!payload?.sessionToken}`);
      appendAuditFailure({
        actorEmail:   '',
        action:       AuditAction.ADMIN_AUTH_REJECTED,
        resourceType: 'event',
        stage:        'auth',
        message:      auth.response?.message,
        attemptedPayload: payload as unknown as Record<string, unknown>,
      });
      return auth.response;
    }
    Logger.log(`[serverCreateEvent] authenticated as ${auth.adminEmail} (role=${auth.adminRole}, club=${auth.adminClubId})`);

    const raw = sanitizePayload(payload as unknown as Record<string, unknown>);
    const eventValidation = validateCreateEventPayload(raw);
    if (eventValidation.status !== ResultStatus.SUCCESS || !eventValidation.data) {
      const fieldSummary = (eventValidation.errors ?? [])
        .map((e) => `${e.field}: ${e.message}`)
        .join('; ');
      Logger.log(
        `[serverCreateEvent] validation failed — actor=${auth.adminEmail} ` +
        `eventName="${String(raw['eventName'] ?? '')}" eventDate="${String(raw['eventDate'] ?? '')}" ` +
        `errors=[${fieldSummary}]`
      );
      appendAuditFailure({
        actorEmail:   auth.adminEmail,
        action:       AuditAction.EVENT_CREATE_FAILED,
        resourceType: 'event',
        stage:        'payload_validation',
        message:      eventValidation.message,
        errors:       eventValidation.errors,
        attemptedPayload: raw,
      });
      return { status: 'error', message: eventValidation.message, errors: eventValidation.errors };
    }
    const eventInput = eventValidation.data;
    Logger.log(`[serverCreateEvent] validated — eventName="${eventInput.eventName}" eventDate="${eventInput.eventDate}"`);

    const result = createEvent(eventInput, auth.adminEmail);
    if (result.status !== ResultStatus.SUCCESS || !result.data) {
      const fieldSummary = (result.errors ?? [])
        .map((e) => `${e.field}: ${e.message}`)
        .join('; ');
      Logger.log(
        `[serverCreateEvent] createEvent service failed — actor=${auth.adminEmail} ` +
        `eventName="${eventInput.eventName}" eventDate="${eventInput.eventDate}" ` +
        `message="${result.message}" errors=[${fieldSummary}]`
      );
      appendAuditFailure({
        actorEmail:   auth.adminEmail,
        action:       AuditAction.EVENT_CREATE_FAILED,
        resourceType: 'event',
        stage:        'service_layer',
        message:      result.message,
        errors:       result.errors,
        attemptedPayload: raw,
      });
      return { status: 'error', message: result.message, errors: result.errors };
    }
    const warnings: string[] = [];
    const eventRecord = result.data as { eventId: string; eventName: string; eventDate: string };
    appendAuditLog({
      actorEmail: auth.adminEmail, action: AuditAction.EVENT_CREATED,
      resourceType: 'event', resourceId: eventRecord.eventId,
      details: { eventName: eventInput.eventName, eventDate: eventInput.eventDate },
    });
    Logger.log(
      `[serverCreateEvent] success — eventId=${eventRecord.eventId} ` +
      `eventName="${eventRecord.eventName}" actor=${auth.adminEmail}`
    );
    try {
      notifyEventCreated(eventRecord.eventName, eventRecord.eventDate, auth.adminEmail);
    } catch (emailErr) {
      const msg = `Event notification email could not be sent: ${String(emailErr)}`;
      Logger.log(`[serverCreateEvent] notifyEventCreated failed (non-fatal): ${String(emailErr)}`);
      warnings.push(msg);
    }
    // Instant metadata push (§5A B8): ask the cloud-webapp to reconcile Drive/
    // Sheet metadata now so this event + its name appear in Find Me within
    // seconds instead of waiting on the daily reconciler. Best-effort — never
    // fails event creation; the daily `findme-drive-sync` job is the backstop.
    try {
      triggerMetadataSync('event_created');
    } catch (syncErr) {
      Logger.log(`[serverCreateEvent] metadata sync trigger error (non-fatal): ${String(syncErr)}`);
    }
    return {
      status: result.status,
      message: result.message,
      data: result.data,
      errors: result.errors,
      ...(warnings.length > 0 && { warnings }),
    };
  } catch (err) {
    Logger.log(`[serverCreateEvent] unhandled exception: ${String(err)}`);
    appendAuditFailure({
      actorEmail:   '',
      action:       AuditAction.EVENT_CREATE_FAILED,
      resourceType: 'event',
      stage:        'unhandled_exception',
      message:      String(err),
      attemptedPayload: payload as unknown as Record<string, unknown>,
    });
    return { status: 'error', message: 'Internal error creating event' };
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function serverUpdateEvent(payload: WithSession): ServerResponse {
  Logger.log(`[serverUpdateEvent] entry — payload keys=[${payloadKeys(payload)}]`);
  try {
    const auth = requireAdminOrFail(payload?.sessionToken);
    if (!auth.ok) {
      Logger.log(`[serverUpdateEvent] auth rejected — sessionToken present=${!!payload?.sessionToken}`);
      appendAuditFailure({
        actorEmail:   '',
        action:       AuditAction.ADMIN_AUTH_REJECTED,
        resourceType: 'event',
        stage:        'auth',
        message:      auth.response?.message,
        attemptedPayload: payload as unknown as Record<string, unknown>,
      });
      return auth.response;
    }
    Logger.log(`[serverUpdateEvent] authenticated as ${auth.adminEmail} (role=${auth.adminRole})`);

    const rawUpdate = sanitizePayload(payload as unknown as Record<string, unknown>);
    const eventUpdateValidation = validateUpdateEventPayload(rawUpdate);
    if (eventUpdateValidation.status !== ResultStatus.SUCCESS || !eventUpdateValidation.data) {
      Logger.log(`[serverUpdateEvent] validation failed — actor=${auth.adminEmail} message="${eventUpdateValidation.message}"`);
      appendAuditFailure({
        actorEmail:   auth.adminEmail,
        action:       AuditAction.EVENT_UPDATE_FAILED,
        resourceType: 'event',
        resourceId:   String(rawUpdate['eventId'] ?? ''),
        stage:        'payload_validation',
        message:      eventUpdateValidation.message,
        errors:       eventUpdateValidation.errors,
        attemptedPayload: rawUpdate,
      });
      return { status: 'error', message: eventUpdateValidation.message, errors: eventUpdateValidation.errors };
    }
    const eventUpdateInput = eventUpdateValidation.data;

    const result = updateEvent(eventUpdateInput, auth.adminEmail);
    if (result.status !== ResultStatus.SUCCESS) {
      Logger.log(`[serverUpdateEvent] service failed — actor=${auth.adminEmail} eventId=${eventUpdateInput.eventId} message="${result.message}"`);
      appendAuditFailure({
        actorEmail:   auth.adminEmail,
        action:       AuditAction.EVENT_UPDATE_FAILED,
        resourceType: 'event',
        resourceId:   eventUpdateInput.eventId,
        stage:        'service_layer',
        message:      result.message,
        errors:       result.errors,
        attemptedPayload: rawUpdate,
      });
      return { status: result.status, message: result.message, data: result.data, errors: result.errors };
    }
    appendAuditLog({
      actorEmail: auth.adminEmail, action: AuditAction.EVENT_UPDATED,
      resourceType: 'event', resourceId: eventUpdateInput.eventId,
      details: eventUpdateInput as unknown as Record<string, unknown>,
    });
    Logger.log(`[serverUpdateEvent] success — eventId=${eventUpdateInput.eventId} actor=${auth.adminEmail}`);
    return { status: result.status, message: result.message, data: result.data, errors: result.errors };
  } catch (err) {
    Logger.log(`[serverUpdateEvent] unhandled exception: ${String(err)}`);
    appendAuditFailure({
      actorEmail:   '',
      action:       AuditAction.EVENT_UPDATE_FAILED,
      resourceType: 'event',
      stage:        'unhandled_exception',
      message:      String(err),
      attemptedPayload: payload as unknown as Record<string, unknown>,
    });
    return { status: 'error', message: 'Internal error updating event' };
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function serverListEvents(payload: WithSession): ServerResponse {
  try {
    const authResult = authenticateRequest(payload?.sessionToken);
    if (authResult.status !== ResultStatus.SUCCESS || !authResult.data) {
      return { status: 'error', message: 'Authentication required' };
    }
    const page     = (payload.page     as number | undefined) ?? 1;
    const pageSize = Math.min((payload.pageSize as number | undefined) ?? 20, 100);
    const sort     = (payload.sort === 'asc' ? 'asc' : 'desc') as 'asc' | 'desc';
    const result   = listAllEvents(page, pageSize, sort);
    let filtered   = result.items as typeof result.items;
    if (payload.dateFrom) filtered = filtered.filter((e) => e.eventDate >= payload.dateFrom!);
    if (payload.dateTo)   filtered = filtered.filter((e) => e.eventDate <= payload.dateTo!);
    return {
      status: 'success',
      message: `Found ${filtered.length} event(s)`,
      data: { items: filtered, total: filtered.length, page, pageSize },
    };
  } catch (err) {
    Logger.log(`serverListEvents error: ${String(err)}`);
    return { status: 'error', message: 'Internal error listing events' };
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function serverScanViolations(payload: WithSession): ServerResponse {
  try {
    const authResult = authenticateRequest(payload?.sessionToken);
    if (authResult.status !== ResultStatus.SUCCESS || !authResult.data) {
      return { status: 'error', message: 'Authentication required' };
    }
    const result = scanAllViolations();
    return { status: result.status, message: result.message, data: result.data };
  } catch (err) {
    Logger.log(`serverScanViolations error: ${String(err)}`);
    return { status: 'error', message: 'Internal error scanning violations' };
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function serverListClubs(payload: WithSession): ServerResponse {
  try {
    const authResult = authenticateRequest(payload?.sessionToken);
    if (authResult.status !== ResultStatus.SUCCESS || !authResult.data) {
      return { status: 'error', message: 'Authentication required' };
    }
    const clubs = payload.activeOnly ? listActiveClubs() : listAllClubs(1, 100).items;
    return {
      status: 'success',
      message: `Found ${clubs.length} club(s)`,
      data: { items: clubs, total: clubs.length },
    };
  } catch (err) {
    Logger.log(`serverListClubs error: ${String(err)}`);
    return { status: 'error', message: 'Internal error listing clubs' };
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function serverCreateClub(payload: WithSession): ServerResponse {
  Logger.log(`[serverCreateClub] entry — payload keys=[${payloadKeys(payload)}]`);
  try {
    const auth = requireAdminOrFail(payload?.sessionToken);
    if (!auth.ok) {
      Logger.log(`[serverCreateClub] auth rejected — sessionToken present=${!!payload?.sessionToken}`);
      appendAuditFailure({
        actorEmail:   '',
        action:       AuditAction.ADMIN_AUTH_REJECTED,
        resourceType: 'club',
        stage:        'auth',
        message:      auth.response?.message,
        attemptedPayload: payload as unknown as Record<string, unknown>,
      });
      return auth.response;
    }
    Logger.log(`[serverCreateClub] authenticated as ${auth.adminEmail} (role=${auth.adminRole})`);

    const rawClub = sanitizePayload(payload as unknown as Record<string, unknown>);
    const clubCreateValidation = validateCreateClubPayload(rawClub);
    if (clubCreateValidation.status !== ResultStatus.SUCCESS || !clubCreateValidation.data) {
      Logger.log(`[serverCreateClub] validation failed — actor=${auth.adminEmail} message="${clubCreateValidation.message}"`);
      appendAuditFailure({
        actorEmail:   auth.adminEmail,
        action:       AuditAction.CLUB_CREATE_FAILED,
        resourceType: 'club',
        stage:        'payload_validation',
        message:      clubCreateValidation.message,
        errors:       clubCreateValidation.errors,
        attemptedPayload: rawClub,
      });
      return { status: 'error', message: clubCreateValidation.message, errors: clubCreateValidation.errors };
    }
    const clubCreateInput = clubCreateValidation.data;

    const result = createClub(clubCreateInput, auth.adminEmail);
    if (result.status !== ResultStatus.SUCCESS) {
      Logger.log(
        `[serverCreateClub] service failed — actor=${auth.adminEmail} ` +
        `normalizedName="${clubCreateInput.normalizedName}" message="${result.message}"`
      );
      appendAuditFailure({
        actorEmail:   auth.adminEmail,
        action:       AuditAction.CLUB_CREATE_FAILED,
        resourceType: 'club',
        resourceId:   clubCreateInput.normalizedName,
        stage:        'service_layer',
        message:      result.message,
        errors:       result.errors,
        attemptedPayload: rawClub,
      });
      return { status: result.status, message: result.message, data: result.data, errors: result.errors };
    }
    appendAuditLog({
      actorEmail: auth.adminEmail, action: AuditAction.CLUB_CREATED,
      resourceType: 'club', resourceId: clubCreateInput.normalizedName,
      details: { displayName: clubCreateInput.displayName, normalizedName: clubCreateInput.normalizedName },
    });
    Logger.log(`[serverCreateClub] success — normalizedName="${clubCreateInput.normalizedName}" actor=${auth.adminEmail}`);
    return { status: result.status, message: result.message, data: result.data, errors: result.errors };
  } catch (err) {
    Logger.log(`[serverCreateClub] unhandled exception: ${String(err)}`);
    appendAuditFailure({
      actorEmail:   '',
      action:       AuditAction.CLUB_CREATE_FAILED,
      resourceType: 'club',
      stage:        'unhandled_exception',
      message:      String(err),
      attemptedPayload: payload as unknown as Record<string, unknown>,
    });
    return { status: 'error', message: 'Internal error creating club' };
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function serverUpdateClub(payload: WithSession): ServerResponse {
  Logger.log(`[serverUpdateClub] entry — payload keys=[${payloadKeys(payload)}]`);
  try {
    const auth = requireAdminOrFail(payload?.sessionToken);
    if (!auth.ok) {
      Logger.log(`[serverUpdateClub] auth rejected — sessionToken present=${!!payload?.sessionToken}`);
      appendAuditFailure({
        actorEmail:   '',
        action:       AuditAction.ADMIN_AUTH_REJECTED,
        resourceType: 'club',
        stage:        'auth',
        message:      auth.response?.message,
        attemptedPayload: payload as unknown as Record<string, unknown>,
      });
      return auth.response;
    }
    Logger.log(`[serverUpdateClub] authenticated as ${auth.adminEmail} (role=${auth.adminRole})`);

    const rawClubUpdate = sanitizePayload(payload as unknown as Record<string, unknown>);
    const clubUpdateValidation = validateUpdateClubPayload(rawClubUpdate);
    if (clubUpdateValidation.status !== ResultStatus.SUCCESS || !clubUpdateValidation.data) {
      Logger.log(`[serverUpdateClub] validation failed — actor=${auth.adminEmail} message="${clubUpdateValidation.message}"`);
      appendAuditFailure({
        actorEmail:   auth.adminEmail,
        action:       AuditAction.CLUB_UPDATE_FAILED,
        resourceType: 'club',
        resourceId:   String(rawClubUpdate['normalizedName'] ?? ''),
        stage:        'payload_validation',
        message:      clubUpdateValidation.message,
        errors:       clubUpdateValidation.errors,
        attemptedPayload: rawClubUpdate,
      });
      return { status: 'error', message: clubUpdateValidation.message, errors: clubUpdateValidation.errors };
    }
    const clubUpdateInput = clubUpdateValidation.data;

    const result = updateClub(clubUpdateInput, auth.adminEmail);
    if (result.status !== ResultStatus.SUCCESS) {
      Logger.log(`[serverUpdateClub] service failed — actor=${auth.adminEmail} normalizedName="${clubUpdateInput.normalizedName}" message="${result.message}"`);
      appendAuditFailure({
        actorEmail:   auth.adminEmail,
        action:       AuditAction.CLUB_UPDATE_FAILED,
        resourceType: 'club',
        resourceId:   clubUpdateInput.normalizedName,
        stage:        'service_layer',
        message:      result.message,
        errors:       result.errors,
        attemptedPayload: rawClubUpdate,
      });
      return { status: result.status, message: result.message, data: result.data, errors: result.errors };
    }
    appendAuditLog({
      actorEmail: auth.adminEmail, action: AuditAction.CLUB_UPDATED,
      resourceType: 'club', resourceId: clubUpdateInput.normalizedName,
      details: clubUpdateInput as unknown as Record<string, unknown>,
    });
    Logger.log(`[serverUpdateClub] success — normalizedName="${clubUpdateInput.normalizedName}" actor=${auth.adminEmail}`);
    return { status: result.status, message: result.message, data: result.data, errors: result.errors };
  } catch (err) {
    Logger.log(`[serverUpdateClub] unhandled exception: ${String(err)}`);
    appendAuditFailure({
      actorEmail:   '',
      action:       AuditAction.CLUB_UPDATE_FAILED,
      resourceType: 'club',
      stage:        'unhandled_exception',
      message:      String(err),
      attemptedPayload: payload as unknown as Record<string, unknown>,
    });
    return { status: 'error', message: 'Internal error updating club' };
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function serverDeactivateClub(payload: WithSession<{ normalizedName: string }>): ServerResponse {
  Logger.log(`[serverDeactivateClub] entry — payload keys=[${payloadKeys(payload)}]`);
  try {
    const auth = requireAdminOrFail(payload?.sessionToken);
    if (!auth.ok) {
      Logger.log(`[serverDeactivateClub] auth rejected`);
      appendAuditFailure({
        actorEmail:   '',
        action:       AuditAction.ADMIN_AUTH_REJECTED,
        resourceType: 'club',
        stage:        'auth',
        message:      auth.response?.message,
        attemptedPayload: payload as unknown as Record<string, unknown>,
      });
      return auth.response;
    }
    const nameResult = requireString(sanitizeString(payload?.normalizedName), 'normalizedName');
    if (nameResult.status !== ResultStatus.SUCCESS) {
      Logger.log(`[serverDeactivateClub] validation failed — actor=${auth.adminEmail} message="${nameResult.message}"`);
      appendAuditFailure({
        actorEmail:   auth.adminEmail,
        action:       AuditAction.CLUB_DEACTIVATE_FAILED,
        resourceType: 'club',
        stage:        'payload_validation',
        message:      nameResult.message,
        errors:       nameResult.errors,
        attemptedPayload: payload as unknown as Record<string, unknown>,
      });
      return { status: 'error', message: nameResult.message, errors: nameResult.errors };
    }
    const normalizedName = nameResult.data!;
    const result = deactivateClub(normalizedName);
    if (result.status !== ResultStatus.SUCCESS) {
      Logger.log(`[serverDeactivateClub] service failed — actor=${auth.adminEmail} normalizedName="${normalizedName}" message="${result.message}"`);
      appendAuditFailure({
        actorEmail:   auth.adminEmail,
        action:       AuditAction.CLUB_DEACTIVATE_FAILED,
        resourceType: 'club',
        resourceId:   normalizedName,
        stage:        'service_layer',
        message:      result.message,
        attemptedPayload: payload as unknown as Record<string, unknown>,
      });
      return { status: result.status, message: result.message, data: result.data };
    }
    appendAuditLog({
      actorEmail: auth.adminEmail, action: AuditAction.CLUB_DEACTIVATED,
      resourceType: 'club', resourceId: normalizedName,
      details: { normalizedName },
    });
    Logger.log(`[serverDeactivateClub] success — normalizedName="${normalizedName}" actor=${auth.adminEmail}`);
    return { status: result.status, message: result.message, data: result.data };
  } catch (err) {
    Logger.log(`[serverDeactivateClub] unhandled exception: ${String(err)}`);
    appendAuditFailure({
      actorEmail:   '',
      action:       AuditAction.CLUB_DEACTIVATE_FAILED,
      resourceType: 'club',
      stage:        'unhandled_exception',
      message:      String(err),
      attemptedPayload: payload as unknown as Record<string, unknown>,
    });
    return { status: 'error', message: 'Internal error deactivating club' };
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function serverReactivateClub(payload: WithSession<{ normalizedName: string }>): ServerResponse {
  Logger.log(`[serverReactivateClub] entry — payload keys=[${payloadKeys(payload)}]`);
  try {
    const auth = requireAdminOrFail(payload?.sessionToken);
    if (!auth.ok) {
      Logger.log(`[serverReactivateClub] auth rejected`);
      appendAuditFailure({
        actorEmail:   '',
        action:       AuditAction.ADMIN_AUTH_REJECTED,
        resourceType: 'club',
        stage:        'auth',
        message:      auth.response?.message,
        attemptedPayload: payload as unknown as Record<string, unknown>,
      });
      return auth.response;
    }
    const nameResult = requireString(sanitizeString(payload?.normalizedName), 'normalizedName');
    if (nameResult.status !== ResultStatus.SUCCESS) {
      Logger.log(`[serverReactivateClub] validation failed — actor=${auth.adminEmail} message="${nameResult.message}"`);
      appendAuditFailure({
        actorEmail:   auth.adminEmail,
        action:       AuditAction.CLUB_REACTIVATE_FAILED,
        resourceType: 'club',
        stage:        'payload_validation',
        message:      nameResult.message,
        errors:       nameResult.errors,
        attemptedPayload: payload as unknown as Record<string, unknown>,
      });
      return { status: 'error', message: nameResult.message, errors: nameResult.errors };
    }
    const normalizedName = nameResult.data!;
    const result = reactivateClub(normalizedName);
    if (result.status !== ResultStatus.SUCCESS) {
      Logger.log(`[serverReactivateClub] service failed — actor=${auth.adminEmail} normalizedName="${normalizedName}" message="${result.message}"`);
      appendAuditFailure({
        actorEmail:   auth.adminEmail,
        action:       AuditAction.CLUB_REACTIVATE_FAILED,
        resourceType: 'club',
        resourceId:   normalizedName,
        stage:        'service_layer',
        message:      result.message,
        attemptedPayload: payload as unknown as Record<string, unknown>,
      });
      return { status: result.status, message: result.message, data: result.data };
    }
    appendAuditLog({
      actorEmail: auth.adminEmail, action: AuditAction.CLUB_REACTIVATED,
      resourceType: 'club', resourceId: normalizedName,
      details: { normalizedName },
    });
    Logger.log(`[serverReactivateClub] success — normalizedName="${normalizedName}" actor=${auth.adminEmail}`);
    return { status: result.status, message: result.message, data: result.data };
  } catch (err) {
    Logger.log(`[serverReactivateClub] unhandled exception: ${String(err)}`);
    appendAuditFailure({
      actorEmail:   '',
      action:       AuditAction.CLUB_REACTIVATE_FAILED,
      resourceType: 'club',
      stage:        'unhandled_exception',
      message:      String(err),
      attemptedPayload: payload as unknown as Record<string, unknown>,
    });
    return { status: 'error', message: 'Internal error reactivating club' };
  }
}
