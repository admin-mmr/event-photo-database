import {
  sanitizeString,
  sanitizeEmail,
  sanitizePayload,
  isValidEmail,
  isValidRole,
  isValidStatus,
  isApprovedClub,
  validateCreateUserPayload,
  validateUpdateUserPayload,
  validateFolderNamePayload,
  requireString,
} from '../../src/middleware/inputValidator';
import { ResultStatus, UserRole, UserStatus } from '../../src/types/enums';

describe('inputValidator', () => {

  // ── sanitizeString ────────────────────────────────────────────────────────

  describe('sanitizeString()', () => {
    it('trims leading and trailing whitespace', () => {
      expect(sanitizeString('  hello  ')).toBe('hello');
    });

    it('removes HTML tags (strips tags, content between tags is retained)', () => {
      // Tags are stripped; text content between tags is preserved
      expect(sanitizeString('<script>alert(1)</script>hello')).toBe('alert(1)hello');
      expect(sanitizeString('<b>bold</b>')).toBe('bold');
      expect(sanitizeString('<img src=x>')).toBe('');
    });

    it('removes null bytes', () => {
      expect(sanitizeString('abc\x00def')).toBe('abcdef');
    });

    it('collapses multiple spaces to one', () => {
      expect(sanitizeString('hello   world')).toBe('hello world');
    });

    it('returns empty string for non-string input', () => {
      expect(sanitizeString(123)).toBe('');
      expect(sanitizeString(null)).toBe('');
      expect(sanitizeString(undefined)).toBe('');
      expect(sanitizeString({})).toBe('');
    });

    it('preserves normal ASCII text unchanged', () => {
      expect(sanitizeString('Hello World!')).toBe('Hello World!');
    });

    it('removes HTML tags from XSS injection attempts', () => {
      // Tags are stripped; onerror attribute is removed as part of the tag
      const xss = '<img src=x onerror=alert(1)>';
      expect(sanitizeString(xss)).toBe('');
    });

    it('preserves CJK characters', () => {
      const cjk = '湘舍动公益';
      expect(sanitizeString(cjk)).toBe(cjk);
    });
  });

  // ── sanitizeEmail ─────────────────────────────────────────────────────────

  describe('sanitizeEmail()', () => {
    it('lowercases the email', () => {
      expect(sanitizeEmail('User@Example.COM')).toBe('user@example.com');
    });

    it('trims whitespace', () => {
      expect(sanitizeEmail('  admin@test.org  ')).toBe('admin@test.org');
    });

    it('returns empty string for non-string input', () => {
      expect(sanitizeEmail(null)).toBe('');
    });
  });

  // ── sanitizePayload ───────────────────────────────────────────────────────

  describe('sanitizePayload()', () => {
    it('sanitizes all string values in a flat object', () => {
      const result = sanitizePayload({
        email: '  Admin@EXAMPLE.COM  ',
        role: '<b>admin</b>',
        count: 5,
        active: true,
      });
      // Note: sanitizePayload uses sanitizeString, NOT sanitizeEmail
      expect(result['email']).toBe('Admin@EXAMPLE.COM');  // not lowercased by sanitizePayload
      expect(result['role']).toBe('admin');               // tags stripped
      expect(result['count']).toBe(5);                    // number preserved
      expect(result['active']).toBe(true);                // boolean preserved
    });

    it('recursively sanitizes nested objects', () => {
      const result = sanitizePayload({
        nested: { name: '  hello  ', value: 42 },
      });
      expect((result['nested'] as Record<string, unknown>)['name']).toBe('hello');
    });

    it('preserves arrays without modification', () => {
      const arr = [1, 2, 3];
      const result = sanitizePayload({ items: arr });
      expect(result['items']).toBe(arr);
    });
  });

  // ── isValidEmail ──────────────────────────────────────────────────────────

  describe('isValidEmail()', () => {
    it('returns true for standard email addresses', () => {
      expect(isValidEmail('user@example.com')).toBe(true);
      expect(isValidEmail('user+tag@sub.domain.org')).toBe(true);
      expect(isValidEmail('123@456.co')).toBe(true);
    });

    it('returns false for malformed addresses', () => {
      expect(isValidEmail('')).toBe(false);
      expect(isValidEmail('no-at')).toBe(false);
      expect(isValidEmail('@nodomain.com')).toBe(false);
      expect(isValidEmail('noTLD@domain')).toBe(false);
      expect(isValidEmail('spaces in@email.com')).toBe(false);
    });
  });

  // ── isValidRole ───────────────────────────────────────────────────────────

  describe('isValidRole()', () => {
    it('returns true for all known UserRole values', () => {
      Object.values(UserRole).forEach((r) => expect(isValidRole(r)).toBe(true));
    });

    it('returns false for unknown role strings', () => {
      expect(isValidRole('superadmin')).toBe(false);
      expect(isValidRole('')).toBe(false);
      expect(isValidRole('Admin')).toBe(false); // case-sensitive
    });
  });

  // ── isValidStatus ─────────────────────────────────────────────────────────

  describe('isValidStatus()', () => {
    it('returns true for active and inactive', () => {
      expect(isValidStatus(UserStatus.ACTIVE)).toBe(true);
      expect(isValidStatus(UserStatus.INACTIVE)).toBe(true);
    });

    it('returns false for unknown status strings', () => {
      expect(isValidStatus('suspended')).toBe(false);
      expect(isValidStatus('')).toBe(false);
    });
  });

  // ── isApprovedClub ────────────────────────────────────────────────────────

  describe('isApprovedClub()', () => {
    it('returns true for known normalized club names', () => {
      expect(isApprovedClub('New_Bee')).toBe(true);
      expect(isApprovedClub('Misty_Mountain')).toBe(true);
      expect(isApprovedClub('Nankai')).toBe(true);
    });

    it('returns true for display names', () => {
      expect(isApprovedClub('New Bee')).toBe(true);
      expect(isApprovedClub('Misty Mountain')).toBe(true);
    });

    it('returns false for unknown club names', () => {
      expect(isApprovedClub('Unknown_Club')).toBe(false);
      expect(isApprovedClub('')).toBe(false);
    });
  });

  // ── validateCreateUserPayload ─────────────────────────────────────────────

  describe('validateCreateUserPayload()', () => {
    it('returns SUCCESS with sanitized data for valid input', () => {
      const result = validateCreateUserPayload({
        email: '  Alice@Example.COM  ',
        runningClub: 'New_Bee',
        role: 'user',
      });
      expect(result.status).toBe(ResultStatus.SUCCESS);
      expect(result.data!.email).toBe('alice@example.com');
      expect(result.data!.runningClub).toBe('New_Bee');
      expect(result.data!.role).toBe(UserRole.USER);
    });

    it('returns ERROR when email is missing', () => {
      const result = validateCreateUserPayload({ runningClub: 'New_Bee', role: 'user' });
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(result.errors!.some((e) => e.field === 'email')).toBe(true);
    });

    it('returns ERROR when email format is invalid', () => {
      const result = validateCreateUserPayload({ email: 'bad-email', runningClub: 'New_Bee', role: 'user' });
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(result.errors!.some((e) => e.field === 'email')).toBe(true);
    });

    it('returns ERROR when runningClub is missing', () => {
      const result = validateCreateUserPayload({ email: 'a@b.com', role: 'user' });
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(result.errors!.some((e) => e.field === 'runningClub')).toBe(true);
    });

    it('returns ERROR for invalid role', () => {
      const result = validateCreateUserPayload({ email: 'a@b.com', runningClub: 'New_Bee', role: 'overlord' });
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(result.errors!.some((e) => e.field === 'role')).toBe(true);
    });

    it('strips HTML from runningClub value', () => {
      const result = validateCreateUserPayload({
        email: 'a@b.com',
        runningClub: '<b>New_Bee</b>',
        role: 'user',
      });
      expect(result.status).toBe(ResultStatus.SUCCESS);
      expect(result.data!.runningClub).toBe('New_Bee');
    });
  });

  // ── validateUpdateUserPayload ─────────────────────────────────────────────

  describe('validateUpdateUserPayload()', () => {
    it('returns SUCCESS when only runningClub is updated', () => {
      const result = validateUpdateUserPayload({
        email: 'user@example.com',
        runningClub: 'Misty_Mountain',
      });
      expect(result.status).toBe(ResultStatus.SUCCESS);
      expect(result.data!.runningClub).toBe('Misty_Mountain');
      expect(result.data!.role).toBeUndefined();
    });

    it('returns SUCCESS when only role is updated', () => {
      const result = validateUpdateUserPayload({
        email: 'user@example.com',
        role: 'admin',
      });
      expect(result.status).toBe(ResultStatus.SUCCESS);
      expect(result.data!.role).toBe(UserRole.ADMIN);
    });

    it('returns SUCCESS when only status is updated', () => {
      const result = validateUpdateUserPayload({
        email: 'user@example.com',
        status: 'inactive',
      });
      expect(result.status).toBe(ResultStatus.SUCCESS);
      expect(result.data!.status).toBe(UserStatus.INACTIVE);
    });

    it('returns ERROR when email is missing', () => {
      const result = validateUpdateUserPayload({ runningClub: 'New_Bee' });
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(result.errors!.some((e) => e.field === 'email')).toBe(true);
    });

    it('returns ERROR when no updateable fields are provided', () => {
      const result = validateUpdateUserPayload({ email: 'user@example.com' });
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(result.errors!.some((e) => e.field === '_form')).toBe(true);
    });

    it('returns ERROR for invalid role string', () => {
      const result = validateUpdateUserPayload({ email: 'user@example.com', role: 'wizard' });
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(result.errors!.some((e) => e.field === 'role')).toBe(true);
    });

    it('returns ERROR for invalid status string', () => {
      const result = validateUpdateUserPayload({ email: 'user@example.com', status: 'maybe' });
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(result.errors!.some((e) => e.field === 'status')).toBe(true);
    });
  });

  // ── validateFolderNamePayload ─────────────────────────────────────────────

  describe('validateFolderNamePayload()', () => {
    it('returns SUCCESS for valid inputs', () => {
      const result = validateFolderNamePayload({ folderName: '2025-11-03_NYC_Marathon', layer: 1 });
      expect(result.status).toBe(ResultStatus.SUCCESS);
      expect(result.data!.layer).toBe(1);
    });

    it('returns ERROR when folderName is missing', () => {
      const result = validateFolderNamePayload({ layer: 1 });
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(result.errors!.some((e) => e.field === 'folderName')).toBe(true);
    });

    it('returns ERROR when layer is out of range', () => {
      const result = validateFolderNamePayload({ folderName: 'test', layer: 4 });
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(result.errors!.some((e) => e.field === 'layer')).toBe(true);
    });

    it('returns ERROR when layer is 0', () => {
      const result = validateFolderNamePayload({ folderName: 'test', layer: 0 });
      expect(result.status).toBe(ResultStatus.ERROR);
    });

    it('returns ERROR when layer is not an integer', () => {
      const result = validateFolderNamePayload({ folderName: 'test', layer: 1.5 });
      expect(result.status).toBe(ResultStatus.ERROR);
    });

    it('accepts layer values 1, 2, and 3', () => {
      [1, 2, 3].forEach((layer) => {
        const result = validateFolderNamePayload({ folderName: 'Test_Name', layer });
        expect(result.status).toBe(ResultStatus.SUCCESS);
      });
    });
  });

  // ── requireString ─────────────────────────────────────────────────────────

  describe('requireString()', () => {
    it('returns SUCCESS with the trimmed string', () => {
      const result = requireString('  hello  ', 'name');
      expect(result.status).toBe(ResultStatus.SUCCESS);
      expect(result.data).toBe('hello');
    });

    it('returns ERROR for empty string', () => {
      const result = requireString('', 'name');
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(result.message).toContain('name');
    });

    it('returns ERROR for whitespace-only string', () => {
      const result = requireString('   ', 'field');
      expect(result.status).toBe(ResultStatus.ERROR);
    });

    it('returns ERROR for non-string input', () => {
      const result = requireString(null, 'field');
      expect(result.status).toBe(ResultStatus.ERROR);
    });
  });
});
