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
  validateCreateEventPayload,
  validateUpdateEventPayload,
  isValidNormalizedName,
  validateCreateClubPayload,
  validateUpdateClubPayload,
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

    it('returns false for empty string (validation moved to Clubs sheet)', () => {
      // isApprovedClub now only checks non-empty; actual club membership is
      // enforced via the Clubs sheet at the service layer.
      expect(isApprovedClub('')).toBe(false);
      expect(isApprovedClub('   ')).toBe(false);
    });

    it('returns true for any non-empty string (unknown clubs included)', () => {
      // By design — the sheet-level check handles membership validation
      expect(isApprovedClub('Unknown_Club')).toBe(true);
      expect(isApprovedClub('Brand_New_Club')).toBe(true);
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

  // ── validateCreateEventPayload ────────────────────────────────────────────

  describe('validateCreateEventPayload()', () => {
    it('returns SUCCESS with both fields present', () => {
      const result = validateCreateEventPayload({
        eventName: 'NYC Marathon',
        eventDate: '2026-11-01',
      });
      expect(result.status).toBe(ResultStatus.SUCCESS);
      expect(result.data!.eventName).toBe('NYC Marathon');
      expect(result.data!.eventDate).toBe('2026-11-01');
    });

    it('trims whitespace from eventName and eventDate', () => {
      const result = validateCreateEventPayload({
        eventName: '  Boston Marathon  ',
        eventDate: '  2026-04-21  ',
      });
      expect(result.status).toBe(ResultStatus.SUCCESS);
      expect(result.data!.eventName).toBe('Boston Marathon');
      expect(result.data!.eventDate).toBe('2026-04-21');
    });

    it('returns ERROR when eventName is missing', () => {
      const result = validateCreateEventPayload({ eventDate: '2026-01-01' });
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(result.errors!.some((e) => e.field === 'eventName')).toBe(true);
    });

    it('returns ERROR when eventDate is missing', () => {
      const result = validateCreateEventPayload({ eventName: 'Test' });
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(result.errors!.some((e) => e.field === 'eventDate')).toBe(true);
    });

    it('returns both field errors when both are missing', () => {
      const result = validateCreateEventPayload({});
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(result.errors).toHaveLength(2);
    });

    it('returns ERROR when eventName is non-string', () => {
      const result = validateCreateEventPayload({ eventName: 42, eventDate: '2026-01-01' });
      expect(result.status).toBe(ResultStatus.ERROR);
    });
  });

  // ── validateUpdateEventPayload ────────────────────────────────────────────

  describe('validateUpdateEventPayload()', () => {
    it('returns SUCCESS with eventId and optional fields', () => {
      const result = validateUpdateEventPayload({
        eventId: 'evt-uuid-001',
        eventName: 'Updated Name',
        eventDate: '2026-11-15',
      });
      expect(result.status).toBe(ResultStatus.SUCCESS);
      expect(result.data!.eventId).toBe('evt-uuid-001');
      expect(result.data!.eventName).toBe('Updated Name');
      expect(result.data!.eventDate).toBe('2026-11-15');
    });

    it('returns SUCCESS with eventId only (no optional fields)', () => {
      const result = validateUpdateEventPayload({ eventId: 'evt-uuid-001' });
      expect(result.status).toBe(ResultStatus.SUCCESS);
      expect(result.data!.eventName).toBeUndefined();
      expect(result.data!.eventDate).toBeUndefined();
    });

    it('trims whitespace from eventId', () => {
      const result = validateUpdateEventPayload({ eventId: '  evt-uuid-001  ' });
      expect(result.status).toBe(ResultStatus.SUCCESS);
      expect(result.data!.eventId).toBe('evt-uuid-001');
    });

    it('returns ERROR when eventId is missing', () => {
      const result = validateUpdateEventPayload({ eventName: 'No ID' });
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(result.errors!.some((e) => e.field === 'eventId')).toBe(true);
    });

    it('returns ERROR when eventId is empty string', () => {
      const result = validateUpdateEventPayload({ eventId: '' });
      expect(result.status).toBe(ResultStatus.ERROR);
    });

    it('returns ERROR when eventId is non-string', () => {
      const result = validateUpdateEventPayload({ eventId: 123 });
      expect(result.status).toBe(ResultStatus.ERROR);
    });

    it('includes eventName in output only when it is a string', () => {
      const withString = validateUpdateEventPayload({ eventId: 'x', eventName: 'Run' });
      expect(withString.data!.eventName).toBe('Run');

      const withNonString = validateUpdateEventPayload({ eventId: 'x', eventName: 99 });
      expect(withNonString.data!.eventName).toBeUndefined();
    });
  });

  // ── isValidNormalizedName ─────────────────────────────────────────────────

  describe('isValidNormalizedName()', () => {
    it('accepts alphanumeric names with underscores', () => {
      expect(isValidNormalizedName('New_Bee')).toBe(true);
      expect(isValidNormalizedName('Misty_Mountain_123')).toBe(true);
      expect(isValidNormalizedName('CHI')).toBe(true);
      expect(isValidNormalizedName('Run4Fun')).toBe(true);
    });

    it('rejects names with spaces', () => {
      expect(isValidNormalizedName('New Bee')).toBe(false);
    });

    it('rejects names with hyphens', () => {
      expect(isValidNormalizedName('New-Bee')).toBe(false);
    });

    it('rejects names with special characters', () => {
      expect(isValidNormalizedName('Club!')).toBe(false);
      expect(isValidNormalizedName('Club@Org')).toBe(false);
    });

    it('rejects empty string', () => {
      expect(isValidNormalizedName('')).toBe(false);
    });

    it('trims before testing (whitespace-only fails)', () => {
      expect(isValidNormalizedName('   ')).toBe(false);
    });
  });

  // ── validateCreateClubPayload ─────────────────────────────────────────────

  describe('validateCreateClubPayload()', () => {
    it('returns SUCCESS with valid displayName and normalizedName', () => {
      const result = validateCreateClubPayload({
        displayName: '新蜂',
        normalizedName: 'New_Bee',
      });
      expect(result.status).toBe(ResultStatus.SUCCESS);
      expect(result.data!.displayName).toBe('新蜂');
      expect(result.data!.normalizedName).toBe('New_Bee');
    });

    it('sanitizes string fields (strips HTML tags)', () => {
      const result = validateCreateClubPayload({
        displayName: '<b>Club</b>',
        normalizedName: 'Club',
      });
      expect(result.status).toBe(ResultStatus.SUCCESS);
      expect(result.data!.displayName).toBe('Club');
    });

    it('returns ERROR when displayName is empty', () => {
      const result = validateCreateClubPayload({ displayName: '', normalizedName: 'New_Bee' });
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(result.errors!.some((e) => e.field === 'displayName')).toBe(true);
    });

    it('returns ERROR when normalizedName is empty', () => {
      const result = validateCreateClubPayload({ displayName: '新蜂', normalizedName: '' });
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(result.errors!.some((e) => e.field === 'normalizedName')).toBe(true);
    });

    it('returns ERROR when normalizedName contains spaces', () => {
      const result = validateCreateClubPayload({ displayName: 'New Bee', normalizedName: 'New Bee' });
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(result.errors!.some((e) => e.field === 'normalizedName')).toBe(true);
    });

    it('returns ERROR when normalizedName contains special characters', () => {
      const result = validateCreateClubPayload({ displayName: 'Club', normalizedName: 'Club-99!' });
      expect(result.status).toBe(ResultStatus.ERROR);
    });

    it('returns both errors when both fields are invalid', () => {
      const result = validateCreateClubPayload({ displayName: '', normalizedName: '' });
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(result.errors!.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ── validateUpdateClubPayload ─────────────────────────────────────────────

  describe('validateUpdateClubPayload()', () => {
    it('returns SUCCESS with normalizedName only', () => {
      const result = validateUpdateClubPayload({ normalizedName: 'New_Bee' });
      expect(result.status).toBe(ResultStatus.SUCCESS);
      expect(result.data!.normalizedName).toBe('New_Bee');
      expect(result.data!.displayName).toBeUndefined();
    });

    it('returns SUCCESS with both normalizedName and displayName', () => {
      const result = validateUpdateClubPayload({
        normalizedName: 'New_Bee',
        displayName: 'Updated Display',
      });
      expect(result.status).toBe(ResultStatus.SUCCESS);
      expect(result.data!.displayName).toBe('Updated Display');
    });

    it('sanitizes displayName when provided', () => {
      const result = validateUpdateClubPayload({
        normalizedName: 'New_Bee',
        displayName: '<script>xss</script>Club',
      });
      expect(result.status).toBe(ResultStatus.SUCCESS);
      expect(result.data!.displayName).toBe('xssClub');
    });

    it('returns ERROR when normalizedName is missing', () => {
      const result = validateUpdateClubPayload({ displayName: 'Something' });
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(result.errors!.some((e) => e.field === 'normalizedName')).toBe(true);
    });

    it('returns ERROR when normalizedName is empty string', () => {
      const result = validateUpdateClubPayload({ normalizedName: '' });
      expect(result.status).toBe(ResultStatus.ERROR);
    });

    it('does not include displayName in output when not provided', () => {
      const result = validateUpdateClubPayload({ normalizedName: 'CHI' });
      expect('displayName' in (result.data ?? {})).toBe(false);
    });
  });
});
