/**
 * Unit tests for the handleLogout() API route handler.
 *
 * handleLogout() is a thin handler: it reads the session token from the
 * payload, calls deleteSession(), and returns a JSON success envelope.
 * Tests mock sessionService so they remain focused on handler logic alone.
 * The full create→delete lifecycle is covered in sessionService.test.ts.
 */

// Mock sessionService before imports so the handler picks up the mock
jest.mock('../../src/services/sessionService', () => ({
  createSession: jest.fn(),
  lookupSession: jest.fn(),
  deleteSession: jest.fn(),
}));

import { handleLogout } from '../../src/routes/apiRoutes';
import { deleteSession } from '../../src/services/sessionService';
import { mockContentService } from '../mocks/gasGlobals';

// ─── Typed mock ───────────────────────────────────────────────────────────────

const mockDeleteSession = deleteSession as jest.MockedFunction<typeof deleteSession>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extracts the JSON body from the last ContentService.createTextOutput() call.
 * The real GAS mock just records calls; we inspect what was serialized.
 */
function lastJsonBody(): Record<string, unknown> {
  const calls = mockContentService.createTextOutput.mock.calls;
  const lastArg = calls[calls.length - 1][0] as string;
  return JSON.parse(lastArg) as Record<string, unknown>;
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('handleLogout()', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── Success path ───────────────────────────────────────────────────────────

  it('calls deleteSession() with the token from the payload', () => {
    handleLogout({ session: 'abc-token-123' });
    expect(mockDeleteSession).toHaveBeenCalledWith('abc-token-123');
  });

  it('returns a success envelope with status "success" and code 200', () => {
    handleLogout({ session: 'abc-token-123' });
    const body = lastJsonBody();
    expect(body['status']).toBe('success');
    expect(body['code']).toBe(200);
  });

  it('returns "Logged out successfully" as the message', () => {
    handleLogout({ session: 'abc-token-123' });
    const body = lastJsonBody();
    expect(body['message']).toBe('Logged out successfully');
  });

  it('sets the MIME type to JSON', () => {
    handleLogout({ session: 'abc-token-123' });
    expect(mockContentService.createTextOutput.mock.results[0].value.setMimeType)
      .toHaveBeenCalledWith('application/json');
  });

  // ── Missing / empty token ──────────────────────────────────────────────────

  it('still returns success when the session key is absent from the payload', () => {
    handleLogout({});
    const body = lastJsonBody();
    expect(body['status']).toBe('success');
  });

  it('does not call deleteSession() when no token is present', () => {
    handleLogout({});
    expect(mockDeleteSession).not.toHaveBeenCalled();
  });

  it('does not call deleteSession() when the token is an empty string', () => {
    handleLogout({ session: '' });
    expect(mockDeleteSession).not.toHaveBeenCalled();
  });

  it('does not call deleteSession() when the token is only whitespace', () => {
    handleLogout({ session: '   ' });
    expect(mockDeleteSession).not.toHaveBeenCalled();
  });

  it('still returns success for an empty token (already expired / client cleanup)', () => {
    handleLogout({ session: '' });
    const body = lastJsonBody();
    expect(body['status']).toBe('success');
  });

  // ── Token normalisation ────────────────────────────────────────────────────

  it('trims whitespace from the token before passing it to deleteSession()', () => {
    handleLogout({ session: '  trimmed-token  ' });
    expect(mockDeleteSession).toHaveBeenCalledWith('trimmed-token');
  });

  it('coerces non-string session values to string before processing', () => {
    // Defensive: guard against malformed payloads where `session` is e.g. a number
    handleLogout({ session: 12345 });
    // String('12345').trim() === '12345' → should call deleteSession
    expect(mockDeleteSession).toHaveBeenCalledWith('12345');
  });

  // ── Response shape ─────────────────────────────────────────────────────────

  it('returns data: null in the response envelope', () => {
    handleLogout({ session: 'tok' });
    const body = lastJsonBody();
    expect(body['data']).toBeNull();
  });
});
