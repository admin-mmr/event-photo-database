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
import { ensureEventAlbum } from '../services/photosService';
import { appendAuditLog } from '../services/auditLogService';
import { notifyEventCreated } from '../services/emailService';
import { AuditAction } from '../types/enums';

/* global Logger */

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function serverCreateEvent(payload: WithSession): ServerResponse {
  try {
    const auth = requireAdminOrFail(payload?.sessionToken);
    if (!auth.ok) return auth.response;

    const raw = sanitizePayload(payload as unknown as Record<string, unknown>);
    const eventValidation = validateCreateEventPayload(raw);
    if (eventValidation.status !== ResultStatus.SUCCESS || !eventValidation.data) {
      return { status: 'error', message: eventValidation.message, errors: eventValidation.errors };
    }
    const eventInput = eventValidation.data;

    const result = createEvent(eventInput, auth.adminEmail);
    const warnings: string[] = [];
    if (result.status === ResultStatus.SUCCESS && result.data) {
      const eventRecord = result.data as { eventId: string; eventName: string; eventDate: string };
      appendAuditLog({
        actorEmail: auth.adminEmail, action: AuditAction.EVENT_CREATED,
        resourceType: 'event', resourceId: eventRecord.eventId,
        details: { eventName: eventInput.eventName, eventDate: eventInput.eventDate },
      });
      try {
        notifyEventCreated(eventRecord.eventName, eventRecord.eventDate, auth.adminEmail);
      } catch (emailErr) {
        const msg = `Event notification email could not be sent: ${String(emailErr)}`;
        Logger.log(`[serverCreateEvent] notifyEventCreated failed (non-fatal): ${String(emailErr)}`);
        warnings.push(msg);
      }
      try {
        const albumResult = ensureEventAlbum(
          eventRecord.eventId,
          eventRecord.eventName,
          eventRecord.eventDate
        );
        if (albumResult.status === ResultStatus.SUCCESS && albumResult.data) {
          appendAuditLog({
            actorEmail: auth.adminEmail, action: AuditAction.ALBUM_CREATED,
            resourceType: 'event', resourceId: eventRecord.eventId,
            details: { albumId: albumResult.data.albumId, albumTitle: albumResult.data.albumTitle },
          });
          Logger.log(`[serverCreateEvent] Photos album created: ${albumResult.data.albumId}`);
        } else {
          const msg = `Google Photos album could not be created: ${albumResult.message}`;
          Logger.log(`[serverCreateEvent] Photos album creation failed: ${albumResult.message}`);
          appendAuditLog({
            actorEmail: auth.adminEmail, action: AuditAction.ALBUM_ERROR,
            resourceType: 'event', resourceId: eventRecord.eventId,
            details: { operation: 'ensure_event_album', error: albumResult.message },
          });
          warnings.push(msg);
        }
      } catch (albumErr) {
        const msg = `Google Photos album could not be created: ${String(albumErr)}`;
        Logger.log(`[serverCreateEvent] Photos album error (non-fatal): ${String(albumErr)}`);
        appendAuditLog({
          actorEmail: auth.adminEmail, action: AuditAction.ALBUM_ERROR,
          resourceType: 'event', resourceId: eventRecord.eventId,
          details: { operation: 'ensure_event_album', error: String(albumErr) },
        });
        warnings.push(msg);
      }
    }
    return {
      status: result.status,
      message: result.message,
      data: result.data,
      errors: result.errors,
      ...(warnings.length > 0 && { warnings }),
    };
  } catch (err) {
    Logger.log(`serverCreateEvent error: ${String(err)}`);
    return { status: 'error', message: 'Internal error creating event' };
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function serverUpdateEvent(payload: WithSession): ServerResponse {
  try {
    const auth = requireAdminOrFail(payload?.sessionToken);
    if (!auth.ok) return auth.response;
    const rawUpdate = sanitizePayload(payload as unknown as Record<string, unknown>);
    const eventUpdateValidation = validateUpdateEventPayload(rawUpdate);
    if (eventUpdateValidation.status !== ResultStatus.SUCCESS || !eventUpdateValidation.data) {
      return { status: 'error', message: eventUpdateValidation.message, errors: eventUpdateValidation.errors };
    }
    const eventUpdateInput = eventUpdateValidation.data;

    const result = updateEvent(eventUpdateInput, auth.adminEmail);
    if (result.status === ResultStatus.SUCCESS) {
      appendAuditLog({
        actorEmail: auth.adminEmail, action: AuditAction.EVENT_UPDATED,
        resourceType: 'event', resourceId: eventUpdateInput.eventId,
        details: eventUpdateInput as unknown as Record<string, unknown>,
      });
    }
    return { status: result.status, message: result.message, data: result.data, errors: result.errors };
  } catch (err) {
    Logger.log(`serverUpdateEvent error: ${String(err)}`);
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
  try {
    const auth = requireAdminOrFail(payload?.sessionToken);
    if (!auth.ok) return auth.response;
    const rawClub = sanitizePayload(payload as unknown as Record<string, unknown>);
    const clubCreateValidation = validateCreateClubPayload(rawClub);
    if (clubCreateValidation.status !== ResultStatus.SUCCESS || !clubCreateValidation.data) {
      return { status: 'error', message: clubCreateValidation.message, errors: clubCreateValidation.errors };
    }
    const clubCreateInput = clubCreateValidation.data;

    const result = createClub(clubCreateInput, auth.adminEmail);
    if (result.status === ResultStatus.SUCCESS) {
      appendAuditLog({
        actorEmail: auth.adminEmail, action: AuditAction.CLUB_CREATED,
        resourceType: 'club', resourceId: clubCreateInput.normalizedName,
        details: { displayName: clubCreateInput.displayName, normalizedName: clubCreateInput.normalizedName },
      });
    }
    return { status: result.status, message: result.message, data: result.data, errors: result.errors };
  } catch (err) {
    Logger.log(`serverCreateClub error: ${String(err)}`);
    return { status: 'error', message: 'Internal error creating club' };
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function serverUpdateClub(payload: WithSession): ServerResponse {
  try {
    const auth = requireAdminOrFail(payload?.sessionToken);
    if (!auth.ok) return auth.response;
    const rawClubUpdate = sanitizePayload(payload as unknown as Record<string, unknown>);
    const clubUpdateValidation = validateUpdateClubPayload(rawClubUpdate);
    if (clubUpdateValidation.status !== ResultStatus.SUCCESS || !clubUpdateValidation.data) {
      return { status: 'error', message: clubUpdateValidation.message, errors: clubUpdateValidation.errors };
    }
    const clubUpdateInput = clubUpdateValidation.data;

    const result = updateClub(clubUpdateInput, auth.adminEmail);
    if (result.status === ResultStatus.SUCCESS) {
      appendAuditLog({
        actorEmail: auth.adminEmail, action: AuditAction.CLUB_UPDATED,
        resourceType: 'club', resourceId: clubUpdateInput.normalizedName,
        details: clubUpdateInput as unknown as Record<string, unknown>,
      });
    }
    return { status: result.status, message: result.message, data: result.data, errors: result.errors };
  } catch (err) {
    Logger.log(`serverUpdateClub error: ${String(err)}`);
    return { status: 'error', message: 'Internal error updating club' };
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function serverDeactivateClub(payload: WithSession<{ normalizedName: string }>): ServerResponse {
  try {
    const auth = requireAdminOrFail(payload?.sessionToken);
    if (!auth.ok) return auth.response;
    const nameResult = requireString(sanitizeString(payload?.normalizedName), 'normalizedName');
    if (nameResult.status !== ResultStatus.SUCCESS) {
      return { status: 'error', message: nameResult.message, errors: nameResult.errors };
    }
    const normalizedName = nameResult.data!;
    const result = deactivateClub(normalizedName);
    if (result.status === ResultStatus.SUCCESS) {
      appendAuditLog({
        actorEmail: auth.adminEmail, action: AuditAction.CLUB_DEACTIVATED,
        resourceType: 'club', resourceId: normalizedName,
        details: { normalizedName },
      });
    }
    return { status: result.status, message: result.message, data: result.data };
  } catch (err) {
    Logger.log(`serverDeactivateClub error: ${String(err)}`);
    return { status: 'error', message: 'Internal error deactivating club' };
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function serverReactivateClub(payload: WithSession<{ normalizedName: string }>): ServerResponse {
  try {
    const auth = requireAdminOrFail(payload?.sessionToken);
    if (!auth.ok) return auth.response;
    const nameResult = requireString(sanitizeString(payload?.normalizedName), 'normalizedName');
    if (nameResult.status !== ResultStatus.SUCCESS) {
      return { status: 'error', message: nameResult.message, errors: nameResult.errors };
    }
    const normalizedName = nameResult.data!;
    const result = reactivateClub(normalizedName);
    if (result.status === ResultStatus.SUCCESS) {
      appendAuditLog({
        actorEmail: auth.adminEmail, action: AuditAction.CLUB_REACTIVATED,
        resourceType: 'club', resourceId: normalizedName,
        details: { normalizedName },
      });
    }
    return { status: result.status, message: result.message, data: result.data };
  } catch (err) {
    Logger.log(`serverReactivateClub error: ${String(err)}`);
    return { status: 'error', message: 'Internal error reactivating club' };
  }
}
