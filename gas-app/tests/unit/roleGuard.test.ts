import { requireRole, isAdmin, isSuperAdmin, isClubAdmin, parseUserRole } from '../../src/middleware/roleGuard';
import { UserRole, ResultStatus } from '../../src/types/enums';

describe('roleGuard', () => {
  describe('requireRole()', () => {
    // ─── Super-admin access ───────────────────────────────────────────────────

    it('grants super_admin access to super_admin-required routes', () => {
      const result = requireRole(UserRole.SUPER_ADMIN, UserRole.SUPER_ADMIN);
      expect(result.status).toBe(ResultStatus.SUCCESS);
    });

    it('grants super_admin access to club_admin-required routes', () => {
      const result = requireRole(UserRole.SUPER_ADMIN, UserRole.CLUB_ADMIN);
      expect(result.status).toBe(ResultStatus.SUCCESS);
    });

    // ─── Club-admin access ────────────────────────────────────────────────────

    it('grants club_admin access to club_admin-required routes', () => {
      const result = requireRole(UserRole.CLUB_ADMIN, UserRole.CLUB_ADMIN);
      expect(result.status).toBe(ResultStatus.SUCCESS);
    });

    it('denies club_admin access to super_admin-required routes', () => {
      const result = requireRole(UserRole.CLUB_ADMIN, UserRole.SUPER_ADMIN);
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(result.message).toContain('super_admin');
    });

    // ─── Error message quality ────────────────────────────────────────────────

    it('includes both the user role and required role in the error message', () => {
      const result = requireRole(UserRole.CLUB_ADMIN, UserRole.SUPER_ADMIN);
      expect(result.message).toContain(UserRole.SUPER_ADMIN);
      expect(result.message).toContain(UserRole.CLUB_ADMIN);
    });
  });

  // ─── isAdmin ──────────────────────────────────────────────────────────────────

  describe('isAdmin()', () => {
    it('returns true for SUPER_ADMIN role', () => {
      expect(isAdmin(UserRole.SUPER_ADMIN)).toBe(true);
    });

    it('returns true for CLUB_ADMIN role', () => {
      expect(isAdmin(UserRole.CLUB_ADMIN)).toBe(true);
    });

    it('returns false for an unknown/empty role string', () => {
      expect(isAdmin('' as UserRole)).toBe(false);
    });
  });

  // ─── isSuperAdmin ─────────────────────────────────────────────────────────────

  describe('isSuperAdmin()', () => {
    it('returns true for SUPER_ADMIN role', () => {
      expect(isSuperAdmin(UserRole.SUPER_ADMIN)).toBe(true);
    });

    it('returns false for CLUB_ADMIN role', () => {
      expect(isSuperAdmin(UserRole.CLUB_ADMIN)).toBe(false);
    });
  });

  // ─── isClubAdmin ──────────────────────────────────────────────────────────────

  describe('isClubAdmin()', () => {
    it('returns true for CLUB_ADMIN role', () => {
      expect(isClubAdmin(UserRole.CLUB_ADMIN)).toBe(true);
    });

    it('returns false for SUPER_ADMIN role', () => {
      expect(isClubAdmin(UserRole.SUPER_ADMIN)).toBe(false);
    });
  });

  // ─── parseUserRole ────────────────────────────────────────────────────────────

  describe('parseUserRole()', () => {
    it('parses "super_admin" correctly', () => {
      expect(parseUserRole('super_admin')).toBe(UserRole.SUPER_ADMIN);
    });

    it('parses "club_admin" correctly', () => {
      expect(parseUserRole('club_admin')).toBe(UserRole.CLUB_ADMIN);
    });

    it('is case-insensitive', () => {
      expect(parseUserRole('SUPER_ADMIN')).toBe(UserRole.SUPER_ADMIN);
      expect(parseUserRole('Club_Admin')).toBe(UserRole.CLUB_ADMIN);
    });

    it('trims whitespace', () => {
      expect(parseUserRole('  super_admin  ')).toBe(UserRole.SUPER_ADMIN);
    });

    it('returns null for old/unknown role strings', () => {
      expect(parseUserRole('admin')).toBeNull();
      expect(parseUserRole('user')).toBeNull();
      expect(parseUserRole('api_client')).toBeNull();
      expect(parseUserRole('moderator')).toBeNull();
      expect(parseUserRole('')).toBeNull();
    });
  });
});
