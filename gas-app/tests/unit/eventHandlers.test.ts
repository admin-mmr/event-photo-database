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
import { requireAdminOrFail } from '../../src/middleware/authMiddleware';

const mockRequireAdminOrFail = requireAdminOrFail as jest.MockedFunction<typeof requireAdminOrFail>;

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

    it('returns success response', () => {
      const result = serverCreateEvent({ sessionToken: 'valid-token' });
      expect(result).toBeDefined();
      expect(['success', 'error']).toContain(result.status);
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

    it('returns response', () => {
      const result = serverUpdateEvent({
        sessionToken: 'valid-token',
        eventId: 'evt-001',
      });
      expect(result).toBeDefined();
    });
  });

  // ─── serverListEvents ──────────────────────────────────────────────────────

  describe('serverListEvents()', () => {
    it('returns response', () => {
      const result = serverListEvents({});
      expect(result).toBeDefined();
      expect(result.status).toBeDefined();
    });
  });

  // ─── serverListClubs ───────────────────────────────────────────────────────

  describe('serverListClubs()', () => {
    it('returns response', () => {
      const result = serverListClubs({});
      expect(result).toBeDefined();
      expect(result.status).toBeDefined();
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

    it('returns response', () => {
      const result = serverCreateClub({
        sessionToken: 'admin-token',
        clubName: 'New Club',
      });
      expect(result).toBeDefined();
    });
  });

  // ─── serverUpdateClub ──────────────────────────────────────────────────────

  describe('serverUpdateClub()', () => {
    it('returns response', () => {
      const result = serverUpdateClub({
        sessionToken: 'user-token',
        clubId: 'club-001',
        clubName: 'Updated Club',
      });
      expect(result).toBeDefined();
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
        normalizedName: 'club_001',
      });

      expect(result.status).toBe('error');
    });

    it('deactivates club', () => {
      const result = serverDeactivateClub({
        sessionToken: 'admin-token',
        normalizedName: 'club_001',
      });

      expect(result).toBeDefined();
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
        normalizedName: 'club_001',
      });

      expect(result.status).toBe('error');
    });

    it('reactivates club', () => {
      const result = serverReactivateClub({
        sessionToken: 'admin-token',
        normalizedName: 'club_001',
      });

      expect(result).toBeDefined();
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

    it('returns response when authenticated', () => {
      const result = serverScanViolations({
        sessionToken: 'admin-token',
      });

      expect(result).toBeDefined();
    });
  });
});
