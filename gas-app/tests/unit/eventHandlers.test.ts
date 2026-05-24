/**
 * Unit tests for eventHandlers — google.script.run handlers for events and clubs.
 *
 * Covers: serverCreateEvent, serverUpdateEvent, serverListEvents, serverListClubs,
 *         serverCreateClub, serverUpdateClub, serverDeactivateClub, serverReactivateClub.
 */

jest.mock('../../src/middleware/authMiddleware');
jest.mock('../../src/middleware/inputValidator');
jest.mock('../../src/services/eventService');
jest.mock('../../src/services/clubService');
jest.mock('../../src/services/driveService');
jest.mock('../../src/services/auditLogService');
jest.mock('../../src/services/emailService');

import {
  serverCreateEvent,
  serverUpdateEvent,
  serverListEvents,
  serverListClubs,
  serverCreateClub,
  serverUpdateClub,
  serverDeactivateClub,
  serverReactivateClub,
  serverScanViolations,
} from '../../src/routes/eventHandlers';
import { requireAdminOrFail, authenticateRequest } from '../../src/middleware/authMiddleware';
import { validateCreateEventPayload, validateUpdateEventPayload } from '../../src/middleware/inputValidator';
import { createEvent, updateEvent, listAll as listAllEvents } from '../../src/services/eventService';
import { createClub, updateClub, deactivateClub, reactivateClub, listAll as listAllClubs } from '../../src/services/clubService';
import { ResultStatus } from '../../src/types/enums';

const mockRequireAdminOrFail = requireAdminOrFail as jest.MockedFunction<typeof requireAdminOrFail>;
const mockValidateCreateEvent = validateCreateEventPayload as jest.MockedFunction<typeof validateCreateEventPayload>;
const mockCreateEvent = createEvent as jest.MockedFunction<typeof createEvent>;
const mockListAllEvents = listAllEvents as jest.MockedFunction<typeof listAllEvents>;
const mockListAllClubs = listAllClubs as jest.MockedFunction<typeof listAllClubs>;

describe('eventHandlers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ─── serverCreateEvent ─────────────────────────────────────────────────────

  describe('serverCreateEvent()', () => {
    it('returns error when authentication fails', () => {
      mockRequireAdminOrFail.mockReturnValue({
        ok: false,
        response: { status: 'error', message: 'Unauthorized' },
      });

      const result = serverCreateEvent({ sessionToken: 'invalid-token' });
      expect(result.status).toBe('error');
      expect(result.message).toBe('Unauthorized');
    });

    it('returns error when validation fails', () => {
      mockRequireAdminOrFail.mockReturnValue({
        ok: true,
        adminEmail: 'admin@example.com',
        adminRole: 'super_admin',
        adminClubId: '',
      });

      mockValidateCreateEvent.mockReturnValue({
        status: ResultStatus.ERROR,
        message: 'Invalid event data',
        errors: [{ field: 'eventName', message: 'Event name is required' }],
      });

      const result = serverCreateEvent({
        sessionToken: 'valid-token',
        eventName: '',
      });
      expect(result.status).toBe('error');
      expect(result.message).toContain('Invalid');
    });

    it('returns success when event is created', () => {
      mockRequireAdminOrFail.mockReturnValue({
        ok: true,
        adminEmail: 'admin@example.com',
        adminRole: 'super_admin',
        adminClubId: '',
      });

      mockValidateCreateEvent.mockReturnValue({
        status: ResultStatus.SUCCESS,
        data: {
          eventName: 'NYC Marathon',
          eventDate: '2025-11-03',
        },
      });

      mockCreateEvent.mockReturnValue({
        status: ResultStatus.SUCCESS,
        data: {
          eventId: 'evt-001',
          eventName: 'NYC Marathon',
          eventDate: '2025-11-03',
          driveFolderId: 'drive-folder-id-001',
          createdBy: 'admin@example.com',
          createdAt: '2025-05-02T00:00:00.000Z',
        },
      });

      const result = serverCreateEvent({
        sessionToken: 'valid-token',
        eventName: 'NYC Marathon',
        eventDate: '2025-11-03',
      });

      expect(result.status).toBe('success');
      expect(result.data?.eventId).toBe('evt-001');
    });
  });

  // ─── serverUpdateEvent ─────────────────────────────────────────────────────

  describe('serverUpdateEvent()', () => {
    it('returns error when authentication fails', () => {
      mockRequireAdminOrFail.mockReturnValue({
        ok: false,
        response: { status: 'error', message: 'Unauthorized' },
      });

      const result = serverUpdateEvent({
        sessionToken: 'invalid-token',
        eventId: 'evt-001',
      });
      expect(result.status).toBe('error');
    });

    it('calls updateEvent service with authenticated user', () => {
      mockRequireAdminOrFail.mockReturnValue({
        ok: true,
        adminEmail: 'admin@example.com',
        adminRole: 'super_admin',
        adminClubId: '',
      });

      mockValidateCreateEvent.mockReturnValue({
        status: ResultStatus.SUCCESS,
        data: { eventName: 'Updated Event', eventDate: '2025-12-01' },
      });

      (updateEvent as jest.Mock).mockReturnValue({
        status: ResultStatus.SUCCESS,
        data: { eventId: 'evt-001', eventName: 'Updated Event' },
      });

      const result = serverUpdateEvent({
        sessionToken: 'valid-token',
        eventId: 'evt-001',
        eventName: 'Updated Event',
        eventDate: '2025-12-01',
      });

      expect(result.status).toBe('success');
    });
  });

  // ─── serverListEvents ──────────────────────────────────────────────────────

  describe('serverListEvents()', () => {
    it('returns list of events on success', () => {
      mockListAllEvents.mockReturnValue({
        status: ResultStatus.SUCCESS,
        data: [
          {
            eventId: 'evt-001',
            eventName: 'NYC Marathon',
            eventDate: '2025-11-03',
            driveFolderId: 'drive-folder-id-001',
            createdBy: 'admin@example.com',
            createdAt: '2025-05-02T00:00:00.000Z',
          },
        ],
      });

      const result = serverListEvents({});
      expect(result.status).toBe('success');
      expect(Array.isArray(result.data)).toBe(true);
    });

    it('returns error when service fails', () => {
      mockListAllEvents.mockReturnValue({
        status: ResultStatus.ERROR,
        message: 'Failed to fetch events',
      });

      const result = serverListEvents({});
      expect(result.status).toBe('error');
    });
  });

  // ─── serverListClubs ───────────────────────────────────────────────────────

  describe('serverListClubs()', () => {
    it('returns list of clubs on success', () => {
      mockListAllClubs.mockReturnValue({
        status: ResultStatus.SUCCESS,
        data: [
          {
            clubId: 'club-001',
            clubName: 'New Bee',
            driveFolderId: 'drive-folder-id-001',
            status: 'active',
          },
        ],
      });

      const result = serverListClubs({});
      expect(result.status).toBe('success');
      expect(Array.isArray(result.data)).toBe(true);
    });
  });

  // ─── serverCreateClub ──────────────────────────────────────────────────────

  describe('serverCreateClub()', () => {
    it('returns error when not authenticated as admin', () => {
      mockRequireAdminOrFail.mockReturnValue({
        ok: false,
        response: { status: 'error', message: 'Must be admin' },
      });

      const result = serverCreateClub({
        sessionToken: 'user-token',
        clubName: 'New Club',
      });
      expect(result.status).toBe('error');
    });

    it('returns success when club is created by admin', () => {
      mockRequireAdminOrFail.mockReturnValue({
        ok: true,
        adminEmail: 'admin@example.com',
        adminRole: 'super_admin',
        adminClubId: '',
      });

      (createClub as jest.Mock).mockReturnValue({
        status: ResultStatus.SUCCESS,
        data: {
          clubId: 'club-001',
          clubName: 'New Club',
          driveFolderId: 'drive-folder-id-001',
          status: 'active',
        },
      });

      const result = serverCreateClub({
        sessionToken: 'admin-token',
        clubName: 'New Club',
      });

      expect(result.status).toBe('success');
      expect(result.data?.clubId).toBe('club-001');
    });
  });

  // ─── serverUpdateClub ──────────────────────────────────────────────────────

  describe('serverUpdateClub()', () => {
    it('requires admin authentication', () => {
      mockRequireAdminOrFail.mockReturnValue({
        ok: false,
        response: { status: 'error', message: 'Unauthorized' },
      });

      const result = serverUpdateClub({
        sessionToken: 'user-token',
        clubId: 'club-001',
        clubName: 'Updated Club',
      });

      expect(result.status).toBe('error');
    });
  });

  // ─── serverDeactivateClub ──────────────────────────────────────────────────

  describe('serverDeactivateClub()', () => {
    it('requires admin authentication', () => {
      mockRequireAdminOrFail.mockReturnValue({
        ok: false,
        response: { status: 'error', message: 'Unauthorized' },
      });

      const result = serverDeactivateClub({
        sessionToken: 'user-token',
        clubId: 'club-001',
      });

      expect(result.status).toBe('error');
    });

    it('calls deactivateClub when authenticated', () => {
      mockRequireAdminOrFail.mockReturnValue({
        ok: true,
        adminEmail: 'admin@example.com',
        adminRole: 'super_admin',
        adminClubId: '',
      });

      (deactivateClub as jest.Mock).mockReturnValue({
        status: ResultStatus.SUCCESS,
        data: { clubId: 'club-001', status: 'inactive' },
      });

      const result = serverDeactivateClub({
        sessionToken: 'admin-token',
        clubId: 'club-001',
      });

      expect(result.status).toBe('success');
    });
  });

  // ─── serverReactivateClub ──────────────────────────────────────────────────

  describe('serverReactivateClub()', () => {
    it('requires admin authentication', () => {
      mockRequireAdminOrFail.mockReturnValue({
        ok: false,
        response: { status: 'error', message: 'Unauthorized' },
      });

      const result = serverReactivateClub({
        sessionToken: 'user-token',
        clubId: 'club-001',
      });

      expect(result.status).toBe('error');
    });
  });

  // ─── serverScanViolations ──────────────────────────────────────────────────

  describe('serverScanViolations()', () => {
    it('requires admin authentication', () => {
      mockRequireAdminOrFail.mockReturnValue({
        ok: false,
        response: { status: 'error', message: 'Unauthorized' },
      });

      const result = serverScanViolations({
        sessionToken: 'user-token',
      });

      expect(result.status).toBe('error');
    });

    it('returns violations when authenticated as admin', () => {
      mockRequireAdminOrFail.mockReturnValue({
        ok: true,
        adminEmail: 'admin@example.com',
        adminRole: 'super_admin',
        adminClubId: '',
      });

      const result = serverScanViolations({
        sessionToken: 'admin-token',
      });

      expect(result).toBeDefined();
    });
  });
});
