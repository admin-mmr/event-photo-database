/**
 * apiRoutes.generateLink.test.ts
 *
 * Unit tests for handleGenerateLink — specifically the Phase 7 guard that
 * prevents any role (including super admin) from generating an upload link
 * that targets the admin-club role container.
 */

import { handleGenerateLink } from '../../src/routes/apiRoutes';
import { UserRole, ResultStatus } from '../../src/types/enums';
import { ADMIN_CLUB_ID } from '../../src/config/constants';
import { UserRecord } from '../../src/types/models';

// ─── Mock uploadLinkService ───────────────────────────────────────────────────

jest.mock('../../src/services/uploadLinkService', () => ({
  generateLink:   jest.fn(),
  revokeLink:     jest.fn(),
  listByEvent:    jest.fn(),
  listByClub:     jest.fn(),
  listAll:        jest.fn(),
  findAll:        jest.fn(),
  validateLink:   jest.fn(),
  rotateLink:     jest.fn(),
}));

import { generateLink } from '../../src/services/uploadLinkService';
const mockGenerateLink = generateLink as jest.Mock;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Pulls the raw JSON string passed to ContentService.createTextOutput. */
function responseBody(): Record<string, unknown> {
  const mockCS = (global as Record<string, unknown>)['ContentService'] as {
    createTextOutput: jest.Mock;
  };
  const calls = mockCS.createTextOutput.mock.calls;
  const lastArg = calls[calls.length - 1][0] as string;
  return JSON.parse(lastArg);
}

function superAdmin(): UserRecord {
  return {
    email:     'admin@mmrunners.org',
    firstName: 'Super',
    lastName:  'Admin',
    role:      UserRole.SUPER_ADMIN,
    status:    'active' as UserRecord['status'],
    clubId:    ADMIN_CLUB_ID,
    addedDate: '2025-01-01',
    addedBy:   'system',
    lastLoginAt: '',
  };
}

function clubAdmin(clubId = 'New_Bee'): UserRecord {
  return {
    email:     'club@example.com',
    firstName: 'Club',
    lastName:  'Admin',
    role:      UserRole.CLUB_ADMIN,
    status:    'active' as UserRecord['status'],
    clubId,
    addedDate: '2025-01-01',
    addedBy:   'admin@mmrunners.org',
    lastLoginAt: '',
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
});

describe('handleGenerateLink()', () => {

  // ── Admin-club guard (Phase 7) ─────────────────────────────────────────────

  describe('admin-club guard', () => {
    it('rejects super admin attempting to target the admin club', () => {
      handleGenerateLink({ eventId: 'evt-001', clubName: ADMIN_CLUB_ID }, superAdmin());

      const body = responseBody();
      expect(body['status']).toBe('error');
      expect(body['code']).toBe(400);
      expect((body['message'] as string).toLowerCase()).toContain('admin club');
      expect(mockGenerateLink).not.toHaveBeenCalled();
    });

    it('rejects club admin attempting to target the admin club', () => {
      // A club admin whose own clubId somehow equals ADMIN_CLUB_ID (shouldn't
      // happen in practice, but the guard must fire before any role check).
      handleGenerateLink(
        { eventId: 'evt-001', clubName: ADMIN_CLUB_ID },
        clubAdmin(ADMIN_CLUB_ID)
      );

      const body = responseBody();
      expect(body['status']).toBe('error');
      expect(body['code']).toBe(400);
      expect(mockGenerateLink).not.toHaveBeenCalled();
    });
  });

  // ── Missing fields ─────────────────────────────────────────────────────────

  describe('input validation', () => {
    it('returns 400 when eventId is missing', () => {
      handleGenerateLink({ clubName: 'New_Bee' }, superAdmin());

      const body = responseBody();
      expect(body['status']).toBe('error');
      expect(body['code']).toBe(400);
      expect(mockGenerateLink).not.toHaveBeenCalled();
    });

    it('returns 400 when clubName is missing', () => {
      handleGenerateLink({ eventId: 'evt-001' }, superAdmin());

      const body = responseBody();
      expect(body['status']).toBe('error');
      expect(body['code']).toBe(400);
      expect(mockGenerateLink).not.toHaveBeenCalled();
    });
  });

  // ── Club-admin scope ───────────────────────────────────────────────────────

  describe('club-admin club scope', () => {
    it('rejects club admin generating a link for a different club', () => {
      handleGenerateLink(
        { eventId: 'evt-001', clubName: 'Other_Club' },
        clubAdmin('New_Bee')
      );

      const body = responseBody();
      expect(body['status']).toBe('error');
      expect(body['code']).toBe(403);
      expect(mockGenerateLink).not.toHaveBeenCalled();
    });

    it('allows club admin to generate a link for their own club', () => {
      mockGenerateLink.mockReturnValue({
        status: ResultStatus.SUCCESS,
        message: 'Link created',
        data: { linkId: 'link-001' },
      });

      handleGenerateLink(
        { eventId: 'evt-001', clubName: 'New_Bee' },
        clubAdmin('New_Bee')
      );

      expect(mockGenerateLink).toHaveBeenCalledWith(
        { eventId: 'evt-001', clubName: 'New_Bee' },
        'club@example.com'
      );
      const body = responseBody();
      expect(body['status']).toBe('success');
    });
  });

  // ── Super-admin happy path ─────────────────────────────────────────────────

  describe('super admin', () => {
    it('allows super admin to generate a link for any real club', () => {
      mockGenerateLink.mockReturnValue({
        status: ResultStatus.SUCCESS,
        message: 'Link created',
        data: { linkId: 'link-002' },
      });

      handleGenerateLink(
        { eventId: 'evt-001', clubName: 'Nankai' },
        superAdmin()
      );

      expect(mockGenerateLink).toHaveBeenCalledWith(
        { eventId: 'evt-001', clubName: 'Nankai' },
        'admin@mmrunners.org'
      );
      const body = responseBody();
      expect(body['status']).toBe('success');
    });

    it('surfaces generateLink service errors as 400', () => {
      mockGenerateLink.mockReturnValue({
        status: ResultStatus.ERROR,
        message: 'Event not found',
      });

      handleGenerateLink(
        { eventId: 'bad-evt', clubName: 'New_Bee' },
        superAdmin()
      );

      const body = responseBody();
      expect(body['status']).toBe('error');
      expect(body['code']).toBe(400);
      expect(body['message']).toBe('Event not found');
    });
  });
});
