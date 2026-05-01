import { getCurrentUserEmail, isEditorSession } from '../../src/services/authService';
import { setMockUser, TEST_ADMIN_EMAIL } from '../mocks/gasGlobals';
import { ResultStatus } from '../../src/types/enums';

describe('authService', () => {
  beforeEach(() => setMockUser(TEST_ADMIN_EMAIL));

  describe('getCurrentUserEmail()', () => {
    it('returns SUCCESS with the active user email', () => {
      const result = getCurrentUserEmail();
      expect(result.status).toBe(ResultStatus.SUCCESS);
      expect(result.data?.email).toBe(TEST_ADMIN_EMAIL);
    });

    it('normalizes email to lowercase', () => {
      setMockUser('Admin@EXAMPLE.ORG');
      const result = getCurrentUserEmail();
      expect(result.data?.email).toBe('admin@example.org');
    });

    it('returns ERROR when email is empty string', () => {
      setMockUser('');
      const result = getCurrentUserEmail();
      expect(result.status).toBe(ResultStatus.ERROR);
      // Generic message — under USER_DEPLOYING this is the expected first-visit
      // state, so the text is intentionally non-alarming.
      expect(result.message).toContain('No active session');
    });

    it('returns ERROR when Session.getActiveUser throws', () => {
      const mockSession = (global as Record<string, unknown>)['Session'] as {
        getActiveUser: jest.Mock;
      };
      mockSession.getActiveUser.mockImplementationOnce(() => {
        throw new Error('Session unavailable');
      });
      const result = getCurrentUserEmail();
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(result.message).toContain('No active session');
    });
  });

  describe('isEditorSession()', () => {
    it('returns true when session has an email (editor or active session)', () => {
      setMockUser(TEST_ADMIN_EMAIL);
      expect(isEditorSession()).toBe(true);
    });

    it('returns false when getEmail returns empty string', () => {
      setMockUser('');
      expect(isEditorSession()).toBe(false);
    });

    it('returns false when getActiveUser throws', () => {
      const mockSession = (global as Record<string, unknown>)['Session'] as {
        getActiveUser: jest.Mock;
      };
      mockSession.getActiveUser.mockImplementationOnce(() => {
        throw new Error('Session unavailable');
      });
      expect(isEditorSession()).toBe(false);
    });
  });
});
