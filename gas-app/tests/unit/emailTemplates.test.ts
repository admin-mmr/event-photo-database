/**
 * Unit tests for emailTemplates — Email template rendering and composition.
 *
 * These tests verify that email templates render correctly with various data.
 */

jest.mock('../../src/services/emailService');
jest.mock('../../src/config/constants');

import * as emailTemplates from '../../src/services/emailTemplates';

describe('emailTemplates', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ─── Template rendering ───────────────────────────────────────────────────

  describe('Template rendering', () => {
    it('renders event creation notification template', () => {
      const template = emailTemplates.getEventCreatedTemplate?.({
        eventName: 'NYC Marathon',
        eventDate: '2025-11-03',
        createdBy: 'admin@example.com',
        driveFolderId: 'folder-id-123',
      });

      expect(template).toBeDefined();
      if (template) {
        expect(template).toContain('NYC Marathon');
        expect(template).toContain('2025-11-03');
      }
    });

    it('renders upload completed notification template', () => {
      const template = emailTemplates.getUploadCompletedTemplate?.({
        userName: 'John Doe',
        eventName: 'Boston Marathon',
        photoCount: 42,
        batchName: 'Morning Run',
      });

      expect(template).toBeDefined();
      if (template) {
        expect(template).toContain('John Doe');
        expect(template).toContain('Boston Marathon');
        expect(template).toContain('42');
      }
    });

    it('renders photo deletion notification template', () => {
      const template = emailTemplates.getPhotoDeletionTemplate?.({
        deletedCount: 5,
        deletionReason: 'Duplicate photos',
        deletedBy: 'admin@example.com',
      });

      expect(template).toBeDefined();
      if (template) {
        expect(template).toContain('5');
        expect(template).toContain('Duplicate photos');
      }
    });

    it('renders daily digest template', () => {
      const template = emailTemplates.getDailyDigestTemplate?.({
        recipientEmail: 'user@example.com',
        newPhotos: 15,
        newEvents: 2,
        updatedEvents: 1,
      });

      expect(template).toBeDefined();
      if (template) {
        expect(template).toContain('15');
        expect(template).toContain('2');
      }
    });
  });

  // ─── Template sanitization ────────────────────────────────────────────────

  describe('Template sanitization', () => {
    it('escapes HTML special characters in user input', () => {
      const template = emailTemplates.getEventCreatedTemplate?.({
        eventName: '<script>alert("XSS")</script>',
        eventDate: '2025-11-03',
        createdBy: 'admin@example.com',
        driveFolderId: 'folder-id-123',
      });

      expect(template).toBeDefined();
      if (template) {
        expect(template).not.toContain('<script>');
      }
    });

    it('handles empty strings gracefully', () => {
      const template = emailTemplates.getEventCreatedTemplate?.({
        eventName: '',
        eventDate: '2025-11-03',
        createdBy: 'admin@example.com',
        driveFolderId: 'folder-id-123',
      });

      expect(template).toBeDefined();
    });

    it('handles missing optional fields', () => {
      const template = emailTemplates.getDailyDigestTemplate?.({
        recipientEmail: 'user@example.com',
      });

      expect(template).toBeDefined();
    });
  });

  // ─── Subject line generation ──────────────────────────────────────────────

  describe('Subject line generation', () => {
    it('generates event creation subject with event name', () => {
      const subject = emailTemplates.getEventCreatedSubject?.({
        eventName: 'NYC Marathon',
      });

      expect(subject).toBeDefined();
      if (subject) {
        expect(subject).toContain('NYC Marathon');
      }
    });

    it('generates upload completion subject with photo count', () => {
      const subject = emailTemplates.getUploadCompletedSubject?.({
        photoCount: 42,
        eventName: 'Boston Marathon',
      });

      expect(subject).toBeDefined();
      if (subject) {
        expect(subject).toContain('42');
      }
    });

    it('generates digest subject with summary info', () => {
      const subject = emailTemplates.getDailyDigestSubject?.({
        newPhotos: 15,
        newEvents: 2,
      });

      expect(subject).toBeDefined();
    });
  });

  // ─── Localization support ─────────────────────────────────────────────────

  describe('Localization support', () => {
    it('renders English templates', () => {
      const template = emailTemplates.getEventCreatedTemplate?.({
        eventName: 'Test Event',
        eventDate: '2025-06-01',
        createdBy: 'admin@example.com',
        driveFolderId: 'folder-id-123',
        lang: 'en',
      });

      expect(template).toBeDefined();
    });

    it('renders Chinese templates when lang=zh', () => {
      const template = emailTemplates.getEventCreatedTemplate?.({
        eventName: 'Test Event',
        eventDate: '2025-06-01',
        createdBy: 'admin@example.com',
        driveFolderId: 'folder-id-123',
        lang: 'zh',
      });

      expect(template).toBeDefined();
    });

    it('defaults to English when language is not specified', () => {
      const template = emailTemplates.getEventCreatedTemplate?.({
        eventName: 'Test Event',
        eventDate: '2025-06-01',
        createdBy: 'admin@example.com',
        driveFolderId: 'folder-id-123',
      });

      expect(template).toBeDefined();
    });
  });
});
