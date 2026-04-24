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

    const result = createEvent(
      { eventName: payload.eventName as string, eventDate: payload.eventDate as string },
      auth.adminEmail
    );
    const warnings: string[] = [];
    if (result.status === ResultStatus.SUCCESS && result.data) {
      const eventRecord = result.data as { eventId: string; eventName: string; eventDate: string };
      appendAuditLog({
        actorEmail: auth.adminEmail, action: AuditAction.EVENT_CREATED,
        resourceType: 'event', resourceId: eventRecord.eventId,
        details: { eventName: payload.eventName, eventDate: payload.eventDate },
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
    const result = updateEvent(
      {
        eventId: payload.eventId as string,
        ...(payload.eventName !== undefined && { eventName: payload.eventName as string }),
        ...(payload.eventDate !== undefined && { eventDate: payload.eventDate as string }),
      },
      auth.adminEmail
    );
    if (result.status === ResultStatus.SUCCESS) {
      const changes: Record<string, unknown> = { eventId: payload.eventId };
      if (payload.eventName !== undefined) changes['eventName'] = payload.eventName;
      if (payload.eventDate !== undefined) changes['eventDate'] = payload.eventDate;
      appendAuditLog({
        actorEmail: auth.adminEmail, action: AuditAction.EVENT_UPDATED,
        resourceType: 'event', resourceId: payload.eventId as string, details: changes,
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
    const result = createClub(
      { displayName: payload.displayName as string, normalizedName: payload.normalizedName as string },
      auth.adminEmail
    );
    if (result.status === ResultStatus.SUCCESS) {
      appendAuditLog({
        actorEmail: auth.adminEmail, action: AuditAction.CLUB_CREATED,
        resourceType: 'club', resourceId: payload.normalizedName as string,
        details: { displayName: payload.displayName, normalizedName: payload.normalizedName },
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
    const result = updateClub(
      {
        normalizedName: payload.normalizedName as string,
        ...(payload.displayName !== undefined && { displayName: payload.displayName as string }),
      },
      auth.adminEmail
    );
    if (result.status === ResultStatus.SUCCESS) {
      const changes: Record<string, unknown> = { normalizedName: payload.normalizedName };
      if (payload.displayName !== undefined) changes['displayName'] = payload.displayName;
      appendAuditLog({
        actorEmail: auth.adminEmail, action: AuditAction.CLUB_UPDATED,
        resourceType: 'club', resourceId: payload.normalizedName as string, details: changes,
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
    const result = deactivateClub(payload.normalizedName);
    if (result.status === ResultStatus.SUCCESS) {
      appendAuditLog({
        actorEmail: auth.adminEmail, action: AuditAction.CLUB_DEACTIVATED,
        resourceType: 'club', resourceId: payload.normalizedName,
        details: { normalizedName: payload.normalizedName },
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
    const result = reactivateClub(payload.normalizedName);
    if (result.status === ResultStatus.SUCCESS) {
      appendAuditLog({
        actorEmail: auth.adminEmail, action: AuditAction.CLUB_REACTIVATED,
        resourceType: 'club', resourceId: payload.normalizedName,
        details: { normalizedName: payload.normalizedName },
      });
    }
    return { status: result.status, message: result.message, data: result.data };
  } catch (err) {
    Logger.log(`serverReactivateClub error: ${String(err)}`);
    return { status: 'error', message: 'Internal error reactivating club' };
  }
}
