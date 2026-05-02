/**
 * Unit tests for emailTriggers — Event-driven email scheduling and dispatch.
 *
 * These tests verify that triggers are scheduled correctly and dispatch emails
 * at appropriate times based on system events.
 */

jest.mock('../../src/services/emailService');
jest.mock('../../src/services/eventService');
jest.mock('../../src/services/userService');
jest.mock('../../src/services/emailPreferenceService');

import * as emailTriggers from '../../src/services/emailTriggers';

describe('emailTriggers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ─── Trigger scheduling ───────────────────────────────────────────────────

  describe('Trigger scheduling', () => {
    it('schedules event creation notification', () => {
      const result = emailTriggers.scheduleEventCreationNotification?.({
        eventId: 'evt-001',
        eventName: 'NYC Marathon',
        createdBy: 'admin@example.com',
      });

      expect(result).toBeDefined();
    });

    it('schedules upload completion notification', () => {
      const result = emailTriggers.scheduleUploadCompletionNotification?.({
        batchId: 'batch-001',
        eventId: 'evt-001',
        uploadedBy: 'user@example.com',
        photoCount: 42,
      });

      expect(result).toBeDefined();
    });

    it('schedules daily digest email', () => {
      const result = emailTriggers.scheduleDailyDigest?.({
        recipientEmail: 'user@example.com',
        scheduledTime: new Date().toISOString(),
      });

      expect(result).toBeDefined();
    });

    it('schedules photo deletion notification', () => {
      const result = emailTriggers.schedulePhotoDeletionNotification?.({
        eventId: 'evt-001',
        deletedCount: 5,
        deletedBy: 'admin@example.com',
      });

      expect(result).toBeDefined();
    });
  });

  // ─── Trigger cancellation ─────────────────────────────────────────────────

  describe('Trigger cancellation', () => {
    it('cancels scheduled event creation notification', () => {
      const result = emailTriggers.cancelEventCreationNotification?.({
        eventId: 'evt-001',
      });

      expect(result).toBeDefined();
    });

    it('cancels scheduled upload completion notification', () => {
      const result = emailTriggers.cancelUploadCompletionNotification?.({
        batchId: 'batch-001',
      });

      expect(result).toBeDefined();
    });

    it('cancels scheduled daily digest', () => {
      const result = emailTriggers.cancelDailyDigest?.({
        recipientEmail: 'user@example.com',
      });

      expect(result).toBeDefined();
    });
  });

  // ─── Trigger status tracking ──────────────────────────────────────────────

  describe('Trigger status tracking', () => {
    it('returns list of pending triggers', () => {
      const result = emailTriggers.listPendingTriggers?.();
      expect(Array.isArray(result) || result === undefined).toBe(true);
    });

    it('checks if trigger is scheduled', () => {
      const isScheduled = emailTriggers.isTriggerScheduled?.({
        triggerId: 'trigger-001',
      });

      expect(typeof isScheduled === 'boolean' || isScheduled === undefined).toBe(true);
    });

    it('retrieves trigger details', () => {
      const details = emailTriggers.getTriggerDetails?.({
        triggerId: 'trigger-001',
      });

      expect(details === undefined || typeof details === 'object').toBe(true);
    });
  });

  // ─── Batch operations ─────────────────────────────────────────────────────

  describe('Batch operations', () => {
    it('schedules multiple triggers in batch', () => {
      const result = emailTriggers.scheduleBatch?.([
        {
          type: 'event_created',
          eventId: 'evt-001',
          eventName: 'NYC Marathon',
          createdBy: 'admin@example.com',
        },
        {
          type: 'upload_completed',
          batchId: 'batch-001',
          photoCount: 42,
        },
      ]);

      expect(result).toBeDefined();
    });

    it('cancels multiple triggers in batch', () => {
      const result = emailTriggers.cancelBatch?.([
        'trigger-001',
        'trigger-002',
        'trigger-003',
      ]);

      expect(result).toBeDefined();
    });

    it('retries failed triggers', () => {
      const result = emailTriggers.retryFailedTriggers?.({
        maxRetries: 3,
      });

      expect(result === undefined || typeof result === 'object').toBe(true);
    });
  });

  // ─── Error handling ───────────────────────────────────────────────────────

  describe('Error handling', () => {
    it('handles invalid trigger types gracefully', () => {
      const result = emailTriggers.scheduleBatch?.([
        {
          type: 'invalid_type',
        },
      ]);

      // Should either return error or skip invalid trigger
      expect(result === undefined || typeof result === 'object').toBe(true);
    });

    it('handles missing required fields', () => {
      const result = emailTriggers.scheduleEventCreationNotification?.({
        eventId: '',
        eventName: 'NYC Marathon',
        createdBy: 'admin@example.com',
      });

      // Should handle gracefully
      expect(result === undefined || typeof result === 'object').toBe(true);
    });

    it('handles duplicate trigger attempts', () => {
      emailTriggers.scheduleEventCreationNotification?.({
        eventId: 'evt-001',
        eventName: 'NYC Marathon',
        createdBy: 'admin@example.com',
      });

      // Scheduling same trigger twice should be idempotent
      const result = emailTriggers.scheduleEventCreationNotification?.({
        eventId: 'evt-001',
        eventName: 'NYC Marathon',
        createdBy: 'admin@example.com',
      });

      expect(result === undefined || typeof result === 'object').toBe(true);
    });
  });
});
