/**
 * main.ts — GAS Web App entry points and google.script.run server functions.
 *
 * doGet(e)  → delegates to Router.handleGet (page routing)
 * doPost(e) → delegates to Router.handlePost (JSON API routing)
 *
 * serverXxx functions are exposed to the browser via google.script.run.
 * They all authenticate the caller and enforce admin-only access where needed.
 */

import { ResultStatus, UserRole, UserStatus, UploadSource, AuditAction } from './types/enums';
import { verifyGoogleIdToken } from './services/tokenService';
import { createSession } from './services/sessionService';
import {
  ensureEventAlbum,
  syncBatchToAlbums,
  syncEventToAlbums,
  backfillAllAlbums,
  findAlbumsByEvent,
  reconcileAllPhotos,
  EventInfo,
} from './services/photosService';
import {
  createJob,
  getJob,
  completeJob,
  requestCancel,
  sweepExpired,
  SyncJob,
} from './services/syncJobService';
import { authenticateRequest, resolveUser } from './middleware/authMiddleware';
import { requireRole } from './middleware/roleGuard';
import { handleGet, handlePost } from './routes/router';
import { createUser, deactivateUser, reactivateUser, updateUser } from './services/userService';
import { createEvent, updateEvent, listAll as listAllEvents, findById as findEventById } from './services/eventService';
import { createClub, updateClub, deactivateClub, reactivateClub, listAll as listAllClubs, listActive as listActiveClubs, findByNormalizedName as findClubByNormalizedName } from './services/clubService';
import {
  scanAllViolations,
  getOrCreateClubFolder,
  getClubFolderTree,
  createBatchFolder,
  getEventDriveTree,
} from './services/driveService';
import { appendUploadLog } from './services/uploadLogService';
import { appendAuditLog, getAuditLogs } from './services/auditLogService';
import { generateSummary, summaryToCsv, buildExceptionEmailBody } from './services/summaryService';
import { buildLayer3FolderName } from './utils/folderNameValidator';
import { toBatchTimestamp } from './utils/dateFormatter';

/* global Logger, DriveApp, Utilities, MailApp */

// ─── Web App entry points ─────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function doGet(
  e: GoogleAppsScript.Events.DoGet
): GoogleAppsScript.HTML.HtmlOutput {
  return handleGet(e);
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function doPost(
  e: GoogleAppsScript.Events.DoPost
): GoogleAppsScript.Content.TextOutput {
  return handlePost(e);
}

// ─── Debug helper (run from GAS editor: select debugConfig → Run) ────────────

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function debugClientId(): void {
  /* global PropertiesService */
  const clientId = PropertiesService.getScriptProperties().getProperty('GOOGLE_CLIENT_ID') ?? '(not set)';
  Logger.log('GOOGLE_CLIENT_ID = [' + clientId + ']');
  Logger.log('Length = ' + clientId.length);
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function debugConfig(): void {
  /* global ScriptApp, PropertiesService, Session */
  const clientId     = PropertiesService.getScriptProperties().getProperty('GOOGLE_CLIENT_ID')     ?? '(not set)';
  const clientSecret = PropertiesService.getScriptProperties().getProperty('GOOGLE_CLIENT_SECRET') ?? '(not set)';
  const deployUrl    = ScriptApp.getService().getUrl();
  const activeEmail  = Session.getActiveUser().getEmail()    || '(empty)';
  const effectEmail  = Session.getEffectiveUser().getEmail() || '(empty)';

  Logger.log('=== debugConfig ===');
  Logger.log('GOOGLE_CLIENT_ID:     [' + clientId + ']');
  Logger.log('GOOGLE_CLIENT_SECRET: ' + (clientSecret !== '(not set)' ? clientSecret.substring(0, 10) + '…' : '(not set)'));
  Logger.log('Deployment URL:       ' + deployUrl);
  Logger.log('Active user email:    ' + activeEmail);
  Logger.log('Effective user email: ' + effectEmail);
  Logger.log('===================');
}

// ─── google.script.run server functions ──────────────────────────────────────

type ServerResponse = { status: string; message: string; data?: unknown; errors?: unknown };

/**
 * Every google.script.run payload carries an optional sessionToken so the
 * server can authenticate the caller (required with USER_DEPLOYING deployment).
 */
type WithSession<T = Record<string, unknown>> = T & { sessionToken?: string };

/**
 * Path A — Google Identity Services login.
 *
 * Called from the login page after the client-side GIS button returns a
 * credential JWT. This function:
 *   1. Verifies the JWT signature via Google's tokeninfo endpoint
 *   2. Checks the email against the Users sheet
 *   3. Creates a 30-min server-side session in CacheService
 *   4. Returns { sessionToken, email, role } to the client
 *
 * The client stores sessionToken in sessionStorage and passes it with every
 * subsequent google.script.run call and page navigation (?session=TOKEN).
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function serverVerifyGoogleToken(idToken: string): ServerResponse {
  try {
    // Step 1: verify the JWT with Google's tokeninfo endpoint
    const tokenResult = verifyGoogleIdToken(idToken);
    if (tokenResult.status !== ResultStatus.SUCCESS || !tokenResult.data) {
      Logger.log(`[serverVerifyGoogleToken] Token invalid: ${tokenResult.message}`);
      return { status: 'error', message: tokenResult.message };
    }

    const email = tokenResult.data.email;
    Logger.log(`[serverVerifyGoogleToken] Token valid for: ${email}`);

    // Step 2: check the email against the Users sheet
    const authResult = resolveUser(email);
    if (authResult.status !== ResultStatus.SUCCESS || !authResult.data) {
      Logger.log(`[serverVerifyGoogleToken] User lookup failed for ${email}: ${authResult.message}`);
      return { status: 'error', message: authResult.message };
    }

    // Step 3: create a 30-min server-side session
    const sessionToken = createSession(email, authResult.data.role);
    Logger.log(`[serverVerifyGoogleToken] Session created for ${email} (${authResult.data.role})`);

    return {
      status: 'success',
      message: 'Authenticated',
      data: { sessionToken, email, role: authResult.data.role },
    };
  } catch (err) {
    Logger.log(`[serverVerifyGoogleToken] Error: ${String(err)}`);
    return { status: 'error', message: `Authentication error: ${String(err)}` };
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function serverCreateUser(
  payload: WithSession<{ email: string; runningClub: string; role: string }>
): ServerResponse {
  try {
    const auth = requireAdminOrFail(payload?.sessionToken);
    if (!auth.ok) return auth.response;
    const result = createUser(
      { email: payload.email, runningClub: payload.runningClub, role: payload.role as UserRole },
      auth.adminEmail
    );
    if (result.status === ResultStatus.SUCCESS) {
      appendAuditLog({
        actorEmail: auth.adminEmail, action: AuditAction.USER_CREATED,
        resourceType: 'user', resourceId: payload.email,
        details: { email: payload.email, runningClub: payload.runningClub, role: payload.role },
      });
    }
    return { status: result.status, message: result.message, data: result.data, errors: result.errors };
  } catch (err) {
    Logger.log(`serverCreateUser error: ${String(err)}`);
    return { status: 'error', message: 'Internal error creating user' };
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function serverUpdateUser(
  payload: WithSession
): ServerResponse {
  try {
    const auth = requireAdminOrFail(payload?.sessionToken);
    if (!auth.ok) return auth.response;
    const result = updateUser(
      {
        email: payload.email,
        ...(payload.runningClub !== undefined && { runningClub: payload.runningClub }),
        ...(payload.role !== undefined && { role: payload.role as UserRole }),
        ...(payload.status !== undefined && { status: payload.status as UserStatus }),
      },
      auth.adminEmail
    );
    if (result.status === ResultStatus.SUCCESS) {
      const changes: Record<string, unknown> = { email: payload.email };
      if (payload.runningClub !== undefined) changes['runningClub'] = payload.runningClub;
      if (payload.role       !== undefined) changes['role']        = payload.role;
      if (payload.status     !== undefined) changes['status']      = payload.status;
      appendAuditLog({
        actorEmail: auth.adminEmail, action: AuditAction.USER_UPDATED,
        resourceType: 'user', resourceId: payload.email, details: changes,
      });
    }
    return { status: result.status, message: result.message, data: result.data, errors: result.errors };
  } catch (err) {
    Logger.log(`serverUpdateUser error: ${String(err)}`);
    return { status: 'error', message: 'Internal error updating user' };
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function serverDeactivateUser(payload: WithSession<{ email: string }>): ServerResponse {
  try {
    const auth = requireAdminOrFail(payload?.sessionToken);
    if (!auth.ok) return auth.response;
    const result = deactivateUser(payload.email);
    if (result.status === ResultStatus.SUCCESS) {
      appendAuditLog({
        actorEmail: auth.adminEmail, action: AuditAction.USER_DEACTIVATED,
        resourceType: 'user', resourceId: payload.email, details: { email: payload.email },
      });
    }
    return { status: result.status, message: result.message, data: result.data };
  } catch (err) {
    Logger.log(`serverDeactivateUser error: ${String(err)}`);
    return { status: 'error', message: 'Internal error deactivating user' };
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function serverReactivateUser(payload: WithSession<{ email: string }>): ServerResponse {
  try {
    const auth = requireAdminOrFail(payload?.sessionToken);
    if (!auth.ok) return auth.response;
    const result = reactivateUser(payload.email);
    if (result.status === ResultStatus.SUCCESS) {
      appendAuditLog({
        actorEmail: auth.adminEmail, action: AuditAction.USER_REACTIVATED,
        resourceType: 'user', resourceId: payload.email, details: { email: payload.email },
      });
    }
    return { status: result.status, message: result.message, data: result.data };
  } catch (err) {
    Logger.log(`serverReactivateUser error: ${String(err)}`);
    return { status: 'error', message: 'Internal error reactivating user' };
  }
}

// ─── Event server functions ───────────────────────────────────────────────────

/**
 * google.script.run entry point for creating an event from the admin UI.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function serverCreateEvent(
  payload: WithSession
): ServerResponse {
  try {
    const auth = requireAdminOrFail(payload?.sessionToken);
    if (!auth.ok) return auth.response;

    const result = createEvent(
      { eventName: payload.eventName, eventDate: payload.eventDate },
      auth.adminEmail
    );
    if (result.status === ResultStatus.SUCCESS && result.data) {
      const eventRecord = result.data as { eventId: string; eventName: string; eventDate: string };
      appendAuditLog({
        actorEmail: auth.adminEmail, action: AuditAction.EVENT_CREATED,
        resourceType: 'event', resourceId: eventRecord.eventId,
        details: { eventName: payload.eventName, eventDate: payload.eventDate },
      });

      // Phase 6: auto-create the master Google Photos album for this event
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
          Logger.log(`[serverCreateEvent] Photos album creation failed: ${albumResult.message}`);
          appendAuditLog({
            actorEmail: auth.adminEmail, action: AuditAction.ALBUM_ERROR,
            resourceType: 'event', resourceId: eventRecord.eventId,
            details: { operation: 'ensure_event_album', error: albumResult.message },
          });
        }
      } catch (albumErr) {
        // Album creation failure must not roll back the event creation
        Logger.log(`[serverCreateEvent] Photos album error (non-fatal): ${String(albumErr)}`);
        appendAuditLog({
          actorEmail: auth.adminEmail, action: AuditAction.ALBUM_ERROR,
          resourceType: 'event', resourceId: eventRecord.eventId,
          details: { operation: 'ensure_event_album', error: String(albumErr) },
        });
      }
    }
    return {
      status: result.status,
      message: result.message,
      data: result.data,
      errors: result.errors,
    };
  } catch (err) {
    Logger.log(`serverCreateEvent error: ${String(err)}`);
    return { status: 'error', message: 'Internal error creating event' };
  }
}

/**
 * google.script.run entry point for updating an event from the admin UI.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function serverUpdateEvent(
  payload: WithSession
): ServerResponse {
  try {
    const auth = requireAdminOrFail(payload?.sessionToken);
    if (!auth.ok) return auth.response;

    const result = updateEvent(
      {
        eventId: payload.eventId,
        ...(payload.eventName !== undefined && { eventName: payload.eventName }),
        ...(payload.eventDate !== undefined && { eventDate: payload.eventDate }),
      },
      auth.adminEmail
    );
    if (result.status === ResultStatus.SUCCESS) {
      const changes: Record<string, unknown> = { eventId: payload.eventId };
      if (payload.eventName !== undefined) changes['eventName'] = payload.eventName;
      if (payload.eventDate !== undefined) changes['eventDate'] = payload.eventDate;
      appendAuditLog({
        actorEmail: auth.adminEmail, action: AuditAction.EVENT_UPDATED,
        resourceType: 'event', resourceId: payload.eventId, details: changes,
      });
    }
    return {
      status: result.status,
      message: result.message,
      data: result.data,
      errors: result.errors,
    };
  } catch (err) {
    Logger.log(`serverUpdateEvent error: ${String(err)}`);
    return { status: 'error', message: 'Internal error updating event' };
  }
}

/**
 * google.script.run entry point for listing events.
 * Available to all authenticated users (needed by Phase 3 upload flow).
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function serverListEvents(
  payload: WithSession
): ServerResponse {
  try {
    const authResult = authenticateRequest(payload?.sessionToken);
    if (authResult.status !== ResultStatus.SUCCESS || !authResult.data) {
      return { status: 'error', message: 'Authentication required' };
    }

    const page = payload.page ?? 1;
    const pageSize = Math.min(payload.pageSize ?? 20, 100);
    const sort = (payload.sort === 'asc' ? 'asc' : 'desc') as 'asc' | 'desc';

    const result = listAllEvents(page, pageSize, sort);

    // Optional client-side date range filter
    let filtered = result.items as typeof result.items;
    if (payload.dateFrom) {
      filtered = filtered.filter((e) => e.eventDate >= payload.dateFrom!);
    }
    if (payload.dateTo) {
      filtered = filtered.filter((e) => e.eventDate <= payload.dateTo!);
    }

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

/**
 * google.script.run entry point that triggers a full Drive folder scan.
 * Returns all naming violations found across Layer 1 and Layer 2.
 * Called from the admin events page on load (background, non-blocking).
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function serverScanViolations(): ServerResponse {
  try {
    const authResult = authenticateRequest(payload?.sessionToken);
    if (authResult.status !== ResultStatus.SUCCESS || !authResult.data) {
      return { status: 'error', message: 'Authentication required' };
    }

    const result = scanAllViolations();
    return {
      status: result.status,
      message: result.message,
      data: result.data,
    };
  } catch (err) {
    Logger.log(`serverScanViolations error: ${String(err)}`);
    return { status: 'error', message: 'Internal error scanning violations' };
  }
}

// ─── Club server functions ────────────────────────────────────────────────────

/**
 * google.script.run entry point for listing clubs.
 * Available to all authenticated users (used by upload page club dropdown).
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function serverListClubs(
  payload: WithSession
): ServerResponse {
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

/**
 * google.script.run entry point for creating a club from the admin UI.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function serverCreateClub(
  payload: WithSession
): ServerResponse {
  try {
    const auth = requireAdminOrFail(payload?.sessionToken);
    if (!auth.ok) return auth.response;

    const result = createClub(
      { displayName: payload.displayName, normalizedName: payload.normalizedName },
      auth.adminEmail
    );
    if (result.status === ResultStatus.SUCCESS) {
      appendAuditLog({
        actorEmail: auth.adminEmail, action: AuditAction.CLUB_CREATED,
        resourceType: 'club', resourceId: payload.normalizedName,
        details: { displayName: payload.displayName, normalizedName: payload.normalizedName },
      });
    }
    return { status: result.status, message: result.message, data: result.data, errors: result.errors };
  } catch (err) {
    Logger.log(`serverCreateClub error: ${String(err)}`);
    return { status: 'error', message: 'Internal error creating club' };
  }
}

/**
 * google.script.run entry point for updating a club from the admin UI.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function serverUpdateClub(
  payload: WithSession
): ServerResponse {
  try {
    const auth = requireAdminOrFail(payload?.sessionToken);
    if (!auth.ok) return auth.response;

    const result = updateClub(
      {
        normalizedName: payload.normalizedName,
        ...(payload.displayName !== undefined && { displayName: payload.displayName }),
      },
      auth.adminEmail
    );
    if (result.status === ResultStatus.SUCCESS) {
      const changes: Record<string, unknown> = { normalizedName: payload.normalizedName };
      if (payload.displayName !== undefined) changes['displayName'] = payload.displayName;
      appendAuditLog({
        actorEmail: auth.adminEmail, action: AuditAction.CLUB_UPDATED,
        resourceType: 'club', resourceId: payload.normalizedName, details: changes,
      });
    }
    return { status: result.status, message: result.message, data: result.data, errors: result.errors };
  } catch (err) {
    Logger.log(`serverUpdateClub error: ${String(err)}`);
    return { status: 'error', message: 'Internal error updating club' };
  }
}

/**
 * google.script.run entry point for deactivating a club from the admin UI.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function serverDeactivateClub(payload: WithSession<{ normalizedName: string }>): ServerResponse {
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

/**
 * google.script.run entry point for reactivating a club from the admin UI.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function serverReactivateClub(payload: WithSession<{ normalizedName: string }>): ServerResponse {
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

// ─── Phase 3 — Upload flow server functions ───────────────────────────────────

/**
 * google.script.run entry point for the upload page's event picker.
 * Returns all events (with optional date-range filter) available for upload.
 * Identical to serverListEvents but named separately for clarity in the UI.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function serverListEventsForUpload(
  payload: WithSession
): ServerResponse {
  try {
    const authResult = authenticateRequest(payload?.sessionToken);
    if (authResult.status !== ResultStatus.SUCCESS || !authResult.data) {
      return { status: 'error', message: 'Authentication required' };
    }

    const sort = (payload.sort === 'asc' ? 'asc' : 'desc') as 'asc' | 'desc';
    const result = listAllEvents(1, 200, sort);

    let filtered = result.items as typeof result.items;
    if (payload.dateFrom) {
      filtered = filtered.filter((e) => e.eventDate >= payload.dateFrom!);
    }
    if (payload.dateTo) {
      filtered = filtered.filter((e) => e.eventDate <= payload.dateTo!);
    }

    return {
      status: 'success',
      message: `Found ${filtered.length} event(s)`,
      data: { items: filtered, total: filtered.length },
    };
  } catch (err) {
    Logger.log(`serverListEventsForUpload error: ${String(err)}`);
    return { status: 'error', message: 'Internal error listing events for upload' };
  }
}

/**
 * google.script.run entry point for reading the club's current folder tree.
 *
 * Called after the user selects an event. Returns the existing file list for
 * the club subfolder (so the UI can show what's already uploaded).
 * Does NOT create the club folder — that happens only when uploading.
 *
 * Payload: { eventFolderId: string, clubFolderName: string }
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function serverGetClubFolderTree(
  payload: WithSession
): ServerResponse {
  try {
    const authResult = authenticateRequest(payload?.sessionToken);
    if (authResult.status !== ResultStatus.SUCCESS || !authResult.data) {
      return { status: 'error', message: 'Authentication required' };
    }

    const { eventFolderId, clubFolderName } = payload;
    if (!eventFolderId || !clubFolderName) {
      return { status: 'error', message: 'eventFolderId and clubFolderName are required' };
    }

    const result = getClubFolderTree(eventFolderId, clubFolderName);
    return {
      status: result.status,
      message: result.message,
      data: result.data,
    };
  } catch (err) {
    Logger.log(`serverGetClubFolderTree error: ${String(err)}`);
    return { status: 'error', message: 'Internal error fetching club folder tree' };
  }
}

/**
 * google.script.run entry point to ensure the club folder exists before upload.
 * Gets or creates the Layer 2 club folder inside the selected event folder.
 *
 * Called just before the actual file upload begins (Step 3 → Step 4 transition).
 *
 * Payload: { eventFolderId: string, clubFolderName: string }
 * Returns: { folderId: string, folderName: string }
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function serverEnsureClubFolder(
  payload: WithSession
): ServerResponse {
  try {
    const authResult = authenticateRequest(payload?.sessionToken);
    if (authResult.status !== ResultStatus.SUCCESS || !authResult.data) {
      return { status: 'error', message: 'Authentication required' };
    }

    const { eventFolderId, clubFolderName } = payload;
    if (!eventFolderId || !clubFolderName) {
      return { status: 'error', message: 'eventFolderId and clubFolderName are required' };
    }

    const result = getOrCreateClubFolder(eventFolderId, clubFolderName);
    return {
      status: result.status,
      message: result.message,
      data: result.data,
    };
  } catch (err) {
    Logger.log(`serverEnsureClubFolder error: ${String(err)}`);
    return { status: 'error', message: 'Internal error ensuring club folder' };
  }
}

// ─── Phase 3 — Upload execution server functions ──────────────────────────────

/**
 * google.script.run entry point: creates the upload batch folder.
 *
 * Called once when the user confirms their file list and clicks "Upload".
 * Creates (or retrieves) the club folder, then creates a new timestamped
 * batch folder inside it. The returned IDs are used by subsequent
 * serverUploadFile calls.
 *
 * Payload: { eventFolderId, clubFolderName, usernameHint }
 * Returns: { batchFolderId, batchFolderName, clubFolderId }
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function serverStartUploadSession(payload: WithSession<{
  eventFolderId: string;
  clubFolderName: string;
  usernameHint: string;   // Email local-part used in the batch folder name
}>): ServerResponse {
  try {
    const authResult = authenticateRequest(payload?.sessionToken);
    if (authResult.status !== ResultStatus.SUCCESS || !authResult.data) {
      return { status: 'error', message: 'Authentication required' };
    }

    const { eventFolderId, clubFolderName, usernameHint } = payload;
    if (!eventFolderId || !clubFolderName) {
      return { status: 'error', message: 'eventFolderId and clubFolderName are required' };
    }

    // Ensure club folder exists (Layer 2)
    const clubResult = getOrCreateClubFolder(eventFolderId, clubFolderName);
    if (clubResult.status !== ResultStatus.SUCCESS || !clubResult.data) {
      return { status: 'error', message: clubResult.message };
    }

    // Build batch folder name: YYYYMMDD-HHMMSS_username
    const timestamp = toBatchTimestamp(new Date());
    const safeUsername = (usernameHint || authResult.data.email)
      .split('@')[0]
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, '');
    const batchFolderName = buildLayer3FolderName(timestamp, safeUsername);

    // Create batch folder (Layer 3) — always new (unique timestamp)
    const batchResult = createBatchFolder(clubResult.data.folderId, batchFolderName);
    if (batchResult.status !== ResultStatus.SUCCESS || !batchResult.data) {
      return { status: 'error', message: batchResult.message };
    }

    return {
      status: 'success',
      message: `Upload session started: ${batchFolderName}`,
      data: {
        batchFolderId: batchResult.data.folderId,
        batchFolderName: batchResult.data.folderName,
        clubFolderId: clubResult.data.folderId,
      },
    };
  } catch (err) {
    Logger.log(`serverStartUploadSession error: ${String(err)}`);
    return { status: 'error', message: 'Internal error starting upload session' };
  }
}

/**
 * google.script.run entry point: uploads a single file to Drive.
 *
 * Receives the file as a base64-encoded string and writes it into the
 * given batch folder using DriveApp.createFile(blob). Called once per
 * file, sequentially, from the browser-side upload loop.
 *
 * GAS constraint: max ~50 MB per google.script.run argument.
 * Files larger than this are pre-filtered client-side and never sent.
 *
 * Payload: { batchFolderId, fileName, mimeType, base64Data }
 * Returns: { fileId, fileName, sizeBytes }
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function serverUploadFile(payload: WithSession<{
  batchFolderId: string;
  fileName: string;
  mimeType: string;
  base64Data: string;  // base64-encoded file content (no data URL prefix)
}>): ServerResponse {
  try {
    const authResult = authenticateRequest(payload?.sessionToken);
    if (authResult.status !== ResultStatus.SUCCESS || !authResult.data) {
      return { status: 'error', message: 'Authentication required' };
    }

    const { batchFolderId, fileName, mimeType, base64Data } = payload;
    if (!batchFolderId || !fileName || !base64Data) {
      return { status: 'error', message: 'batchFolderId, fileName, and base64Data are required' };
    }

    // Decode base64 → byte array → Drive Blob
    const bytes = Utilities.base64Decode(base64Data);
    const blob = Utilities.newBlob(bytes, mimeType || 'application/octet-stream', fileName);

    const folder = DriveApp.getFolderById(batchFolderId);
    const file = folder.createFile(blob);

    return {
      status: 'success',
      message: `File "${fileName}" uploaded`,
      data: {
        fileId: file.getId(),
        fileName: file.getName(),
        sizeBytes: file.getSize(),
      },
    };
  } catch (err) {
    Logger.log(`serverUploadFile error: ${String(err)}`);
    return { status: 'error', message: `Failed to upload file: ${String(err)}` };
  }
}

/**
 * google.script.run entry point: uploads multiple files to Drive in one call.
 *
 * Accepts an array of files (each base64-encoded) and writes them all into
 * the given batch folder within a single GAS execution.  This eliminates the
 * per-file round-trip overhead that occurs when calling serverUploadFile once
 * per file — the GAS startup cost is paid just once for the whole bundle.
 *
 * Returns per-file results so the client can surface partial failures without
 * failing the whole bundle.
 *
 * Payload: { batchFolderId, files: [{fileName, mimeType, base64Data}] }
 * Returns: { results: [{fileName, success, fileId?, sizeBytes?, error?}] }
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function serverUploadFiles(payload: WithSession<{
  batchFolderId: string;
  files: Array<{
    fileName:   string;
    mimeType:   string;
    base64Data: string;   // base64-encoded content, no data-URL prefix
  }>;
}>): ServerResponse {
  try {
    const authResult = authenticateRequest(payload?.sessionToken);
    if (authResult.status !== ResultStatus.SUCCESS || !authResult.data) {
      return { status: 'error', message: 'Authentication required' };
    }

    const { batchFolderId, files } = payload;
    if (!batchFolderId || !files || !files.length) {
      return { status: 'error', message: 'batchFolderId and files are required' };
    }

    const folder = DriveApp.getFolderById(batchFolderId);

    // Save every file; capture per-file success/failure so partial batches
    // are reported cleanly rather than failing the whole call.
    const results = files.map((f) => {
      try {
        const bytes  = Utilities.base64Decode(f.base64Data);
        const blob   = Utilities.newBlob(bytes, f.mimeType || 'application/octet-stream', f.fileName);
        const saved  = folder.createFile(blob);
        return { fileName: f.fileName, success: true,  fileId: saved.getId(), sizeBytes: saved.getSize() };
      } catch (e) {
        Logger.log(`serverUploadFiles: failed to save "${f.fileName}": ${String(e)}`);
        return { fileName: f.fileName, success: false, error: String(e) };
      }
    });

    const successCount = results.filter((r) => r.success).length;
    return {
      status:  'success',
      message: `${successCount} of ${files.length} files saved to Drive`,
      data:    { results },
    };
  } catch (err) {
    Logger.log(`serverUploadFiles error: ${String(err)}`);
    return { status: 'error', message: `Failed to upload files: ${String(err)}` };
  }
}

/**
 * google.script.run entry point: finalises the upload session.
 *
 * Called after all files have been uploaded (or attempted). Writes one
 * row to the Upload_Log sheet summarising the session. Returns the log
 * record so the UI can display the final summary screen.
 *
 * Payload: {
 *   eventId, clubFolderName, batchFolderName, batchFolderId,
 *   fileCount, totalSizeMb, skippedDuplicates, skippedNonPhoto
 * }
 * Returns: UploadLogRecord
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function serverCompleteUpload(payload: WithSession<{
  eventId: string;
  clubFolderName: string;
  batchFolderName: string;
  batchFolderId: string;
  fileCount: number;
  totalSizeMb: number;
  skippedDuplicates: number;
  skippedNonPhoto: number;
}>): ServerResponse {
  try {
    const authResult = authenticateRequest(payload?.sessionToken);
    if (authResult.status !== ResultStatus.SUCCESS || !authResult.data) {
      return { status: 'error', message: 'Authentication required' };
    }

    const result = appendUploadLog({
      eventId:           payload.eventId,
      clubName:          payload.clubFolderName,
      uploadedBy:        authResult.data.email,
      batchFolderName:   payload.batchFolderName,
      batchFolderId:     payload.batchFolderId,
      fileCount:         Number(payload.fileCount) || 0,
      totalSizeMb:       Number(payload.totalSizeMb) || 0,
      skippedDuplicates: Number(payload.skippedDuplicates) || 0,
      skippedNonPhoto:   Number(payload.skippedNonPhoto) || 0,
      source:            UploadSource.WEB_APP,
    });

    // Phase 6: auto-sync uploaded photos to Google Photos albums
    if (Number(payload.fileCount) > 0) {
      try {
        const event = findEventById(payload.eventId);
        if (event) {
          // Resolve club display name for album title
          const clubRecord = findClubByNormalizedName(payload.clubFolderName);
          const clubDisplayName = clubRecord?.displayName ?? payload.clubFolderName.replace(/_/g, ' ');

          const syncResult = syncBatchToAlbums(
            event.eventId,
            event.eventName,
            event.eventDate,
            payload.clubFolderName,
            clubDisplayName,
            payload.batchFolderId
          );
          Logger.log(
            `[serverCompleteUpload] Photos sync: ${syncResult.message}`
          );
        }
      } catch (syncErr) {
        // Sync failure must not affect the upload log response
        Logger.log(`[serverCompleteUpload] Photos sync error (non-fatal): ${String(syncErr)}`);
      }
    }

    return {
      status: result.status,
      message: result.message,
      data: result.data,
    };
  } catch (err) {
    Logger.log(`serverCompleteUpload error: ${String(err)}`);
    return { status: 'error', message: 'Internal error completing upload session' };
  }
}

// ─── Phase 4 — Admin Summary server functions ─────────────────────────────────

/**
 * google.script.run entry point: generates a system summary report.
 *
 * Admin-only. Loads all events and upload logs, applies optional date filter,
 * groups uploads by event and club, and scans Drive for naming violations.
 *
 * Payload: { dateFrom?: string; dateTo?: string }   (ISO "YYYY-MM-DD")
 * Returns: SystemSummary
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function serverGetSummary(payload: WithSession<{
  dateFrom?: string;
  dateTo?: string;
}>): ServerResponse {
  try {
    const auth = requireAdminOrFail(payload?.sessionToken);
    if (!auth.ok) return auth.response;

    const result = generateSummary(payload.dateFrom, payload.dateTo);
    return {
      status: result.status,
      message: result.message,
      data: result.data,
    };
  } catch (err) {
    Logger.log(`serverGetSummary error: ${String(err)}`);
    return { status: 'error', message: 'Internal error generating summary' };
  }
}

/**
 * google.script.run entry point: generates a CSV string for download.
 *
 * Admin-only. Calls generateSummary() with the same date filters,
 * then serialises the result to a UTF-8 BOM CSV and returns the raw string.
 * The client receives this string and triggers a browser download via Blob.
 *
 * Payload: { dateFrom?: string; dateTo?: string }
 * Returns: { csv: string }   (the full CSV text)
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function serverExportSummaryCsv(payload: WithSession<{
  dateFrom?: string;
  dateTo?: string;
}>): ServerResponse {
  try {
    const auth = requireAdminOrFail(payload?.sessionToken);
    if (!auth.ok) return auth.response;

    const result = generateSummary(payload.dateFrom, payload.dateTo);
    if (!result.data) {
      return { status: 'error', message: result.message };
    }

    const csv = summaryToCsv(result.data);
    appendAuditLog({
      actorEmail: auth.adminEmail, action: AuditAction.EXPORT_CSV,
      resourceType: 'report', resourceId: '',
      details: { dateFrom: payload.dateFrom ?? null, dateTo: payload.dateTo ?? null },
    });
    return {
      status: 'success',
      message: 'CSV generated',
      data: { csv },
    };
  } catch (err) {
    Logger.log(`serverExportSummaryCsv error: ${String(err)}`);
    return { status: 'error', message: 'Internal error exporting CSV' };
  }
}

/**
 * google.script.run entry point: sends exception notification emails.
 *
 * Admin-only. Generates a fresh summary and emails the body to the
 * requesting admin (and any additional recipients). Only sends if there
 * are actual violations or inactive events; returns SUCCESS with a "nothing
 * to report" message otherwise.
 *
 * Payload: { additionalRecipients?: string[] }
 * Returns: { recipientCount: number }
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function serverSendExceptionEmail(payload: WithSession<{
  additionalRecipients?: string[];
}>): ServerResponse {
  try {
    const auth = requireAdminOrFail(payload?.sessionToken);
    if (!auth.ok) return auth.response;

    const result = generateSummary();
    if (!result.data) {
      return { status: 'error', message: result.message };
    }

    const summary = result.data;
    const hasExceptions =
      summary.violations.length > 0 || summary.eventsWithoutUploads.length > 0;

    if (!hasExceptions) {
      return {
        status: 'success',
        message: 'No exceptions found — email not sent',
        data: { recipientCount: 0 },
      };
    }

    const body = buildExceptionEmailBody(summary);
    const subject = `湘舍动公益文件系统 — Exception Alert (${new Date().toISOString().slice(0, 10)})`;

    // Always include the requesting admin
    const recipients = [auth.adminEmail, ...(payload.additionalRecipients ?? [])];
    // Deduplicate and normalise
    const uniqueRecipients = [...new Set(recipients.map((r) => r.toLowerCase().trim()))];

    for (const recipient of uniqueRecipients) {
      MailApp.sendEmail(recipient, subject, body);
    }

    Logger.log(`[serverSendExceptionEmail] Sent to ${uniqueRecipients.join(', ')}`);
    appendAuditLog({
      actorEmail: auth.adminEmail, action: AuditAction.EXCEPTION_EMAIL_SENT,
      resourceType: 'report', resourceId: '',
      details: { recipients: uniqueRecipients, violationCount: summary.violations.length },
    });
    return {
      status: 'success',
      message: `Exception email sent to ${uniqueRecipients.length} recipient(s)`,
      data: { recipientCount: uniqueRecipients.length },
    };
  } catch (err) {
    Logger.log(`serverSendExceptionEmail error: ${String(err)}`);
    return { status: 'error', message: `Failed to send exception email: ${String(err)}` };
  }
}

// ─── Audit Log server function ────────────────────────────────────────────────

/**
 * google.script.run entry point: returns a paginated, filtered audit log.
 *
 * Admin-only. Returns rows newest-first with optional actor-email substring
 * filter and date-range filter.
 *
 * Payload: { page?, pageSize?, actorEmail?, dateFrom?, dateTo? }
 * Returns: AuditLogPage { items, total, page, pageSize }
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function serverGetAuditLog(payload: WithSession<{
  page?:        number;
  pageSize?:    number;
  actorEmail?:  string;
  dateFrom?:    string;
  dateTo?:      string;
}>): ServerResponse {
  try {
    const auth = requireAdminOrFail(payload?.sessionToken);
    if (!auth.ok) return auth.response;

    const result = getAuditLogs({
      page:        payload.page     ?? 1,
      pageSize:    Math.min(payload.pageSize ?? 50, 200),
      actorEmail:  payload.actorEmail,
      dateFrom:    payload.dateFrom,
      dateTo:      payload.dateTo,
    });
    return { status: result.status, message: result.message, data: result.data };
  } catch (err) {
    Logger.log(`serverGetAuditLog error: ${String(err)}`);
    return { status: 'error', message: 'Internal error fetching audit log' };
  }
}

// ─── Phase 6 — Google Photos Albums server functions ─────────────────────────

/**
 * google.script.run entry point: returns all Google Photos album records for
 * a given event (master event album + per-club albums).
 *
 * Available to all authenticated users so the upload page can surface album links
 * after a successful upload.
 *
 * Payload: { eventId: string }
 * Returns: { albums: PhotosAlbumRecord[] }
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function serverGetEventAlbums(payload: WithSession<{ eventId: string }>): ServerResponse {
  try {
    const authResult = authenticateRequest(payload?.sessionToken);
    if (authResult.status !== ResultStatus.SUCCESS || !authResult.data) {
      return { status: 'error', message: 'Authentication required' };
    }

    if (!payload.eventId) {
      return { status: 'error', message: 'eventId is required' };
    }

    const albums = findAlbumsByEvent(payload.eventId);
    return {
      status: 'success',
      message: `Found ${albums.length} album(s) for event`,
      data: { albums },
    };
  } catch (err) {
    Logger.log(`serverGetEventAlbums error: ${String(err)}`);
    return { status: 'error', message: 'Internal error fetching event albums' };
  }
}

/**
 * google.script.run entry point: triggers a full re-sync of all Drive photos
 * for one event to its Google Photos albums.
 *
 * Admin-only. Useful after manual Drive uploads or when photos were added
 * outside the normal upload pipeline.
 *
 * Progress tracking: the UI should create a SyncJob (via
 * `serverCreateSyncJob`) and pass the resulting `jobId` here. While this
 * function runs on the server, the UI can poll `serverGetSyncJob({jobId})`
 * in parallel (google.script.run calls are concurrent) to render a progress
 * bar, and call `serverCancelSyncJob({jobId})` to abort cooperatively.
 *
 * Payload: { eventId: string; jobId?: string }
 * Returns: SyncEventResult
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function serverSyncAlbum(
  payload: WithSession<{ eventId: string; jobId?: string }>
): ServerResponse {
  const jobId = payload?.jobId;
  try {
    const auth = requireAdminOrFail(payload?.sessionToken);
    if (!auth.ok) {
      if (jobId) completeJob(jobId, 'failed', 'Unauthorized');
      return auth.response;
    }

    if (!payload.eventId) {
      if (jobId) completeJob(jobId, 'failed', 'eventId is required');
      return { status: 'error', message: 'eventId is required' };
    }

    const event = findEventById(payload.eventId);
    if (!event) {
      const msg = `Event "${payload.eventId}" not found`;
      if (jobId) completeJob(jobId, 'failed', msg);
      return { status: 'error', message: msg };
    }

    // Build club display-name lookup map
    const clubDisplayNames: Record<string, string> = {};
    listActiveClubs().forEach((c) => {
      clubDisplayNames[c.normalizedName] = c.displayName;
    });

    const eventInfo: EventInfo = {
      eventId:       event.eventId,
      eventName:     event.eventName,
      eventDate:     event.eventDate,
      driveFolderId: event.driveFolderId,
    };

    const result = syncEventToAlbums(eventInfo, clubDisplayNames, jobId);

    if (result.status === ResultStatus.SUCCESS && result.data) {
      appendAuditLog({
        actorEmail: auth.adminEmail, action: AuditAction.ALBUM_SYNCED,
        resourceType: 'event', resourceId: event.eventId,
        details: {
          totalSynced: result.data.totalSynced,
          clubs: result.data.clubsSynced.length,
          errors: result.data.errors.length,
        },
      });
      // Log any per-club errors that occurred during the sync
      if (result.data.errors.length > 0) {
        appendAuditLog({
          actorEmail: auth.adminEmail, action: AuditAction.ALBUM_ERROR,
          resourceType: 'event', resourceId: event.eventId,
          details: { operation: 'sync_event_to_albums', errors: result.data.errors },
        });
      }
      if (jobId) {
        // Detect cancellation: if the job's current record already has
        // cancelRequested=true, mark it cancelled; otherwise complete.
        const finalState = getJob(jobId);
        if (finalState?.cancelRequested) {
          completeJob(jobId, 'cancelled',
            `Cancelled after syncing ${result.data.totalSynced} photo(s) across ${result.data.clubsSynced.length} club(s)`);
        } else {
          completeJob(jobId, 'completed', result.message);
        }
      }
    } else if (result.status !== ResultStatus.SUCCESS) {
      appendAuditLog({
        actorEmail: auth.adminEmail, action: AuditAction.ALBUM_ERROR,
        resourceType: 'event', resourceId: event.eventId,
        details: { operation: 'sync_event_to_albums', error: result.message },
      });
      if (jobId) completeJob(jobId, 'failed', result.message);
    }

    return {
      status: result.status,
      message: result.message,
      data: result.data,
    };
  } catch (err) {
    Logger.log(`serverSyncAlbum error: ${String(err)}`);
    appendAuditLog({
      actorEmail: 'system', action: AuditAction.ALBUM_ERROR,
      resourceType: 'event', resourceId: payload.eventId ?? '',
      details: { operation: 'sync_event_to_albums', error: String(err) },
    });
    if (jobId) completeJob(jobId, 'failed', `Internal error: ${String(err)}`);
    return { status: 'error', message: `Internal error syncing album: ${String(err)}` };
  }
}

/**
 * google.script.run entry point: creates Google Photos albums for all events
 * and syncs all Drive photos into them.
 *
 * Admin-only. Idempotent — safe to run multiple times.
 * For very large archives, the GAS 6-minute limit may cut the run short;
 * call again to continue (already-synced photos may be duplicated in Google Photos).
 *
 * Payload: {} (no parameters required)
 * Returns: BackfillResult
 */
/**
 * google.script.run entry point: runs a read-only reconciliation audit comparing
 * Drive file counts against Photo_Files sync records for every event.
 *
 * Admin-only. Returns an EventReconciliationResult per event showing how many
 * photos are in Drive vs how many have been confirmed synced to Google Photos.
 * Does NOT upload or modify any data.
 *
 * Payload: {} (no parameters required)
 * Returns: ReconciliationReport
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function serverReconcilePhotos(_payload: Record<string, unknown>): ServerResponse {
  try {
    const auth = requireAdminOrFail(payload?.sessionToken);
    if (!auth.ok) return auth.response;

    const result = reconcileAllPhotos();
    return {
      status: result.status,
      message: result.message,
      data: result.data,
    };
  } catch (err) {
    Logger.log(`serverReconcilePhotos error: ${String(err)}`);
    return { status: 'error', message: `Internal error during reconciliation: ${String(err)}` };
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function serverBackfillAlbums(
  payload: WithSession<{ jobId?: string }>
): ServerResponse {
  const jobId = payload?.jobId;
  try {
    const auth = requireAdminOrFail(payload?.sessionToken);
    if (!auth.ok) {
      if (jobId) completeJob(jobId, 'failed', 'Unauthorized');
      return auth.response;
    }

    // Build club display-name lookup map
    const clubDisplayNames: Record<string, string> = {};
    listActiveClubs().forEach((c) => {
      clubDisplayNames[c.normalizedName] = c.displayName;
    });

    const result = backfillAllAlbums(clubDisplayNames, jobId);

    if (result.status === ResultStatus.SUCCESS && result.data) {
      appendAuditLog({
        actorEmail: auth.adminEmail, action: AuditAction.ALBUM_BACKFILLED,
        resourceType: 'report', resourceId: '',
        details: {
          eventsProcessed: result.data.eventsProcessed,
          albumsCreated:   result.data.albumsCreated,
          totalSynced:     result.data.totalSynced,
          errorCount:      result.data.errors.length,
        },
      });
      // Log any per-event errors encountered during the backfill run
      if (result.data.errors.length > 0) {
        appendAuditLog({
          actorEmail: auth.adminEmail, action: AuditAction.ALBUM_ERROR,
          resourceType: 'report', resourceId: '',
          details: { operation: 'backfill_all_albums', errors: result.data.errors },
        });
      }
      if (jobId) {
        const finalState = getJob(jobId);
        if (finalState?.cancelRequested) {
          completeJob(jobId, 'cancelled',
            `Cancelled after ${result.data.eventsProcessed} event(s), ${result.data.totalSynced} photo(s) synced`);
        } else {
          completeJob(jobId, 'completed', result.message);
        }
      }
    } else if (result.status !== ResultStatus.SUCCESS) {
      appendAuditLog({
        actorEmail: auth.adminEmail, action: AuditAction.ALBUM_ERROR,
        resourceType: 'report', resourceId: '',
        details: { operation: 'backfill_all_albums', error: result.message },
      });
      if (jobId) completeJob(jobId, 'failed', result.message);
    }

    return {
      status: result.status,
      message: result.message,
      data: result.data,
    };
  } catch (err) {
    Logger.log(`serverBackfillAlbums error: ${String(err)}`);
    appendAuditLog({
      actorEmail: 'system', action: AuditAction.ALBUM_ERROR,
      resourceType: 'report', resourceId: '',
      details: { operation: 'backfill_all_albums', error: String(err) },
    });
    if (jobId) completeJob(jobId, 'failed', `Internal error: ${String(err)}`);
    return { status: 'error', message: `Internal error during backfill: ${String(err)}` };
  }
}

// ─── Sync job progress endpoints ─────────────────────────────────────────────
//
// Admin-only lightweight endpoints called by the Photos Overview UI to render
// a live progress bar while serverSyncAlbum / serverBackfillAlbums run. They
// must be cheap (property read only) since the client polls every ~3 seconds.

/**
 * google.script.run entry point: creates a new SyncJob record in 'pending'
 * state and returns the jobId. The UI immediately starts polling
 * `serverGetSyncJob({jobId})` and fires the actual worker (serverSyncAlbum or
 * serverBackfillAlbums) with the same jobId in parallel.
 *
 * Payload: { jobType: 'sync-event' | 'backfill-all'; eventId?: string }
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function serverCreateSyncJob(
  payload: WithSession<{ jobType: SyncJob['jobType']; eventId?: string }>
): ServerResponse {
  try {
    const auth = requireAdminOrFail(payload?.sessionToken);
    if (!auth.ok) return auth.response;

    if (payload.jobType !== 'sync-event' && payload.jobType !== 'backfill-all') {
      return { status: 'error', message: 'Invalid jobType' };
    }
    // Opportunistic cleanup of expired records so the property store doesn't
    // balloon when the admin kicks off a lot of jobs.
    sweepExpired();

    const job = createJob(payload.jobType, payload.eventId ?? '');
    return { status: 'success', message: 'Job created', data: job };
  } catch (err) {
    Logger.log(`serverCreateSyncJob error: ${String(err)}`);
    return { status: 'error', message: `Internal error creating sync job: ${String(err)}` };
  }
}

/**
 * google.script.run entry point: returns the current state of a SyncJob.
 * Called on a ~3-second interval from the Photos Overview UI while a
 * worker is running. Returns 404-style shape if the jobId is unknown.
 *
 * Payload: { jobId: string }
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function serverGetSyncJob(
  payload: WithSession<{ jobId: string }>
): ServerResponse {
  try {
    const auth = requireAdminOrFail(payload?.sessionToken);
    if (!auth.ok) return auth.response;

    if (!payload.jobId) {
      return { status: 'error', message: 'jobId is required' };
    }

    const job = getJob(payload.jobId);
    if (!job) {
      return { status: 'error', message: 'Job not found (expired or invalid id)' };
    }
    return { status: 'success', message: 'OK', data: job };
  } catch (err) {
    Logger.log(`serverGetSyncJob error: ${String(err)}`);
    return { status: 'error', message: `Internal error reading sync job: ${String(err)}` };
  }
}

/**
 * google.script.run entry point: sets the cancel flag on a running job.
 * The worker (serverSyncAlbum / serverBackfillAlbums) checks the flag
 * between units of work and stops gracefully — it does not interrupt an
 * in-flight photo upload, so cancellation can take a few seconds.
 *
 * Payload: { jobId: string }
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function serverCancelSyncJob(
  payload: WithSession<{ jobId: string }>
): ServerResponse {
  try {
    const auth = requireAdminOrFail(payload?.sessionToken);
    if (!auth.ok) return auth.response;

    if (!payload.jobId) {
      return { status: 'error', message: 'jobId is required' };
    }
    const ok = requestCancel(payload.jobId);
    if (!ok) {
      return { status: 'error', message: 'Job not found or already finished' };
    }
    appendAuditLog({
      actorEmail: auth.adminEmail, action: AuditAction.ALBUM_ERROR,
      resourceType: 'report', resourceId: payload.jobId,
      details: { operation: 'cancel_sync_job' },
    });
    return { status: 'success', message: 'Cancel requested — the worker will stop shortly.' };
  } catch (err) {
    Logger.log(`serverCancelSyncJob error: ${String(err)}`);
    return { status: 'error', message: `Internal error cancelling sync job: ${String(err)}` };
  }
}

// ─── Drive file system tree (all authenticated users) ────────────────────────

/**
 * google.script.run entry point: walks the Drive hierarchy for one event and
 * returns a serialisable tree of clubs → batches → photo counts.
 *
 * Available to all authenticated users (not admin-only) — the tree is read-only
 * and exposes only folder names and file counts, no Drive file IDs or metadata.
 *
 * Called lazily: the Drive Tree page loads all event metadata on page load, then
 * calls this function only when the user expands a specific event node.
 *
 * Payload: { eventId: string; driveFolderId: string }
 * Returns: EventDriveTree
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function serverGetDriveTree(
  payload: WithSession
): ServerResponse {
  try {
    const authResult = authenticateRequest(payload?.sessionToken);
    if (authResult.status !== ResultStatus.SUCCESS || !authResult.data) {
      return { status: 'error', message: 'Authentication required' };
    }

    const { eventId, driveFolderId } = payload;
    if (!eventId || !driveFolderId) {
      return { status: 'error', message: 'eventId and driveFolderId are required' };
    }

    const result = getEventDriveTree(eventId, driveFolderId);
    return {
      status: result.status,
      message: result.message,
      data: result.data,
    };
  } catch (err) {
    Logger.log(`serverGetDriveTree error: ${String(err)}`);
    return { status: 'error', message: `Internal error fetching drive tree: ${String(err)}` };
  }
}

// ─── Internal auth helper ─────────────────────────────────────────────────────

type AdminCheckResult =
  | { ok: true; adminEmail: string }
  | { ok: false; response: ServerResponse };

function requireAdminOrFail(sessionToken?: string): AdminCheckResult {
  const authResult = authenticateRequest(sessionToken);
  if (authResult.status !== ResultStatus.SUCCESS || !authResult.data) {
    return { ok: false, response: { status: 'error', message: 'Authentication required' } };
  }
  const guard = requireRole(authResult.data.role, UserRole.ADMIN);
  if (guard.status !== ResultStatus.SUCCESS) {
    return { ok: false, response: { status: 'error', message: guard.message } };
  }
  return { ok: true, adminEmail: authResult.data.email };
}

/**
 * Dev-only: touches every scope in the manifest so a single consent dialog
 * grants them all. Remove after first-deploy authorization is complete.
 *
 * Each call is wrapped in try/catch so one failure (e.g. a missing script
 * property, or an intentionally-invalid token in the UrlFetchApp probe)
 * doesn't abort the run before the remaining scopes are touched — the point
 * is to force Google to aggregate ALL needed scopes into a single consent
 * prompt, not to have any of the calls actually succeed.
 */
export function warmAllScopes(): void {
  const props = PropertiesService.getScriptProperties();
  const sheetId = props.getProperty('SPREADSHEET_ID') ?? '';

  try { if (sheetId) SpreadsheetApp.openById(sheetId); } catch (e) { console.log('[warm] Spreadsheet:', e); }
  try { DriveApp.getRootFolder(); }                     catch (e) { console.log('[warm] Drive:',       e); }
  try { UrlFetchApp.fetch('https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=x'); }
                                                         catch (e) { console.log('[warm] UrlFetch:',   e); }
  try { Session.getActiveUser().getEmail(); }            catch (e) { console.log('[warm] Session:',    e); }
  try { ScriptApp.getService().getUrl(); }               catch (e) { console.log('[warm] ScriptApp:',  e); }
}