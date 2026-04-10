import { requireRole, isAdmin, canUpload, parseUserRole } from '../../src/middleware/roleGuard';
import { UserRole, ResultStatus } from '../../src/types/enums';

describe('roleGuard', () => {
  describe('requireRole()', () => {
    // ─── Admin access ───────────────────────────────────────────────────────

    it('grants admin access to admin-required routes', () => {
      const result = requireRole(UserRole.ADMIN, UserRole.ADMIN);
      expect(result.status).toBe(ResultStatus.SUCCESS);
    });

    it('grants admin access to user-required routes', () => {
      const result = requireRole(UserRole.ADMIN, UserRole.USER);
      expect(result.status).toBe(ResultStatus.SUCCESS);
    });

    it('grants admin access to api_client-required routes', () => {
      const result = requireRole(UserRole.ADMIN, UserRole.API_CLIENT);
      expect(result.status).toBe(ResultStatus.SUCCESS);
    });

    // ─── User access ────────────────────────────────────────────────────────

    it('grants user access to user-required routes', () => {
      const result = requireRole(UserRole.USER, UserRole.USER);
      expect(result.status).toBe(ResultStatus.SUCCESS);
    });

    it('denies user access to admin-required routes', () => {
      const result = requireRole(UserRole.USER, UserRole.ADMIN);
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(result.message).toContain('admin');
    });

    it('grants user access to api_client-required routes', () => {
      const result = requireRole(UserRole.USER, UserRole.API_CLIENT);
      expect(result.status).toBe(ResultStatus.SUCCESS);
    });

    // ─── API_CLIENT access ──────────────────────────────────────────────────

    it('denies api_client access to admin-required routes', () => {
      const result = requireRole(UserRole.API_CLIENT, UserRole.ADMIN);
      expect(result.status).toBe(ResultStatus.ERROR);
    });

    it('denies api_client access to user-required routes', () => {
      const result = requireRole(UserRole.API_CLIENT, UserRole.USER);
      expect(result.status).toBe(ResultStatus.ERROR);
    });

    it('grants api_client access to api_client-required routes', () => {
      const result = requireRole(UserRole.API_CLIENT, UserRole.API_CLIENT);
      expect(result.status).toBe(ResultStatus.SUCCESS);
    });

    // ─── Error message quality ──────────────────────────────────────────────

    it('includes both the user role and required role in the error message', () => {
      const result = requireRole(UserRole.USER, UserRole.ADMIN);
      expect(result.message).toContain(UserRole.ADMIN);
      expect(result.message).toContain(UserRole.USER);
    });
  });

  // ─── isAdmin ─────────────────────────────────────────────────────────────────

  describe('isAdmin()', () => {
    it('returns true for ADMIN role', () => {
      expect(isAdmin(UserRole.ADMIN)).toBe(true);
    });

    it('returns false for USER role', () => {
      expect(isAdmin(UserRole.USER)).toBe(false);
    });

    it('returns false for API_CLIENT role', () => {
      expect(isAdmin(UserRole.API_CLIENT)).toBe(false);
    });
  });

  // ─── canUpload ───────────────────────────────────────────────────────────────

  describe('canUpload()', () => {
    it('returns true for USER role', () => {
      expect(canUpload(UserRole.USER)).toBe(true);
    });

    it('returns true for ADMIN role', () => {
      expect(canUpload(UserRole.ADMIN)).toBe(true);
    });

    it('returns false for API_CLIENT role', () => {
      expect(canUpload(UserRole.API_CLIENT)).toBe(false);
    });
  });

  // ─── parseUserRole ────────────────────────────────────────────────────────────

  describe('parseUserRole()', () => {
    it('parses "admin" correctly', () => {
      expect(parseUserRole('admin')).toBe(UserRole.ADMIN);
    });

    it('parses "user" correctly', () => {
      expect(parseUserRole('user')).toBe(UserRole.USER);
    });

    it('parses "api_client" correctly', () => {
      expect(parseUserRole('api_client')).toBe(UserRole.API_CLIENT);
    });

    it('is case-insensitive', () => {
      expect(parseUserRole('ADMIN')).toBe(UserRole.ADMIN);
      expect(parseUserRole('User')).toBe(UserRole.USER);
    });

    it('trims whitespace', () => {
      expect(parseUserRole('  admin  ')).toBe(UserRole.ADMIN);
    });

    it('returns null for unknown role strings', () => {
      expect(parseUserRole('superadmin')).toBeNull();
      expect(parseUserRole('moderator')).toBeNull();
      expect(parseUserRole('')).toBeNull();
    });
  });
});
