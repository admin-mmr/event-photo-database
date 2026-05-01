/**
 * Tests for the server-side tag-name validation added to
 * uploadLinkService.generateLink().
 *
 * Previously, generateLink() trusted the tag value sent by the client and only
 * the admin UI did character validation (via an HTML `pattern` attribute).
 * Non-browser callers (e.g. curl, scripts) could bypass that and inject Drive-
 * illegal characters into tag names. The validator added in this change runs
 * on the server before any sheet write, so every entry point is covered.
 */

import { generateLink } from '../../src/services/uploadLinkService';
import {
  mockSheets,
  resetMockSheets,
  resetUuidCounter,
  TEST_ADMIN_EMAIL,
} from '../mocks/gasGlobals';
import { ResultStatus } from '../../src/types/enums';

const mockSpreadsheetApp = (global as Record<string, unknown>)['SpreadsheetApp'] as {
  openById: jest.Mock;
};

function useMockSheets() {
  mockSpreadsheetApp.openById.mockReturnValue({
    getSheetByName: jest.fn().mockImplementation((name: string) => mockSheets[name] ?? null),
  });
}

describe('uploadLinkService.generateLink — tag validation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetMockSheets();
    resetUuidCounter();
    useMockSheets();
  });

  // ── Happy paths ────────────────────────────────────────────────────────────

  it('accepts an empty tag (substituted with DEFAULT_TAG)', () => {
    const result = generateLink(
      { eventId: 'evt-001', clubName: 'New_Bee' },
      TEST_ADMIN_EMAIL
    );
    expect(result.status).toBe(ResultStatus.SUCCESS);
    // DEFAULT_TAG is 'ALL'; the link is created and persisted with that tag.
    expect(result.data!.tag).toBe('ALL');
  });

  it('accepts a simple ASCII tag', () => {
    const result = generateLink(
      { eventId: 'evt-001', clubName: 'New_Bee', tag: 'finish_line' },
      TEST_ADMIN_EMAIL
    );
    expect(result.status).toBe(ResultStatus.SUCCESS);
    expect(result.data!.tag).toBe('finish_line');
  });

  it('accepts a tag with hyphens', () => {
    const result = generateLink(
      { eventId: 'evt-001', clubName: 'New_Bee', tag: 'mile-10' },
      TEST_ADMIN_EMAIL
    );
    expect(result.status).toBe(ResultStatus.SUCCESS);
    expect(result.data!.tag).toBe('mile-10');
  });

  it('accepts a Chinese-character tag', () => {
    const result = generateLink(
      { eventId: 'evt-001', clubName: 'New_Bee', tag: '终点线' },
      TEST_ADMIN_EMAIL
    );
    expect(result.status).toBe(ResultStatus.SUCCESS);
    expect(result.data!.tag).toBe('终点线');
  });

  it('accepts a mixed Chinese-English tag', () => {
    const result = generateLink(
      { eventId: 'evt-001', clubName: 'New_Bee', tag: 'mile_10_终点' },
      TEST_ADMIN_EMAIL
    );
    expect(result.status).toBe(ResultStatus.SUCCESS);
  });

  it('trims whitespace around the tag before validating', () => {
    const result = generateLink(
      { eventId: 'evt-001', clubName: 'New_Bee', tag: '  finish_line  ' },
      TEST_ADMIN_EMAIL
    );
    expect(result.status).toBe(ResultStatus.SUCCESS);
    expect(result.data!.tag).toBe('finish_line');
  });

  // ── Failure paths — Drive-illegal characters ───────────────────────────────

  it.each([
    ['/',  'finish/line'],
    ['\\', 'finish\\line'],
    [':',  'finish:line'],
    ['*',  'finish*line'],
    ['?',  'finish?line'],
    ['"',  'finish"line'],
    ['<',  'finish<line'],
    ['>',  'finish>line'],
    ['|',  'finish|line'],
  ])('rejects tag containing Drive-illegal character %s', (illegalChar, badTag) => {
    const result = generateLink(
      { eventId: 'evt-001', clubName: 'New_Bee', tag: badTag },
      TEST_ADMIN_EMAIL
    );
    expect(result.status).toBe(ResultStatus.ERROR);
    // Specific char called out in the message
    expect(result.message).toContain(`"${illegalChar}"`);
    // No row written to the Upload_Links sheet on rejection
    expect(mockSheets['Upload_Links'].appendRow).not.toHaveBeenCalled();
  });

  // ── Failure paths — other invalid input ────────────────────────────────────

  it('rejects tag with an internal space', () => {
    const result = generateLink(
      { eventId: 'evt-001', clubName: 'New_Bee', tag: 'finish line' },
      TEST_ADMIN_EMAIL
    );
    expect(result.status).toBe(ResultStatus.ERROR);
    expect(result.message).toContain('(space)');
    expect(mockSheets['Upload_Links'].appendRow).not.toHaveBeenCalled();
  });

  it('rejects tag with @', () => {
    const result = generateLink(
      { eventId: 'evt-001', clubName: 'New_Bee', tag: 'finish@line' },
      TEST_ADMIN_EMAIL
    );
    expect(result.status).toBe(ResultStatus.ERROR);
    expect(result.message).toContain('"@"');
  });

  it('rejects tag exceeding the 40-character limit', () => {
    const result = generateLink(
      { eventId: 'evt-001', clubName: 'New_Bee', tag: 'a'.repeat(41) },
      TEST_ADMIN_EMAIL
    );
    expect(result.status).toBe(ResultStatus.ERROR);
    expect(result.message).toMatch(/40 characters or fewer/i);
  });

  it('rejects tag at length 41 even for CJK characters', () => {
    const result = generateLink(
      { eventId: 'evt-001', clubName: 'New_Bee', tag: '终'.repeat(41) },
      TEST_ADMIN_EMAIL
    );
    expect(result.status).toBe(ResultStatus.ERROR);
  });
});
