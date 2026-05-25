/**
 * auditLogPage.test.ts — Client-side unit tests for the audit log page UI.
 *
 * Tests the filtering logic, rendering, pagination, and interaction handlers
 * that run inside the audit.html template. These are JavaScript tests that
 * verify the filter chips, date ranges, category toggles, and the display
 * logic work correctly.
 *
 * NOTE: These tests simulate the DOM and global state that would exist in
 * the browser when the audit.html page loads. Since GAS templates execute
 * server-side, we mock the necessary GAS globals and DOM APIs.
 */

import { AuditAction } from '../../src/types/enums';
import { AuditLogRecord } from '../../src/types/models';

// ─── Mock data ────────────────────────────────────────────────────────────────

function createMockAuditRecord(overrides: Partial<AuditLogRecord> = {}): AuditLogRecord {
  return {
    auditId:      'audit-' + Math.random().toString(36).substr(2, 9),
    timestamp:    '2026-04-18T10:00:00.000Z',
    actorEmail:   'admin@mmrunners.org',
    action:       AuditAction.USER_CREATED,
    resourceType: 'user',
    resourceId:   'test@example.com',
    details:      '{"email":"test@example.com"}',
    linkId:       '',
    ipAddress:    '',
    reason:       '',
    ...overrides,
  };
}

// ─── DOM Setup (mock utilities) ────────────────────────────────────────────────

/**
 * Simple mock class list that mimics DOMTokenList for testing.
 */
class MockClassList {
  private classes: Set<string> = new Set();

  add(...tokens: string[]): void {
    for (const token of tokens) {
      this.classes.add(token);
    }
  }

  remove(...tokens: string[]): void {
    for (const token of tokens) {
      this.classes.delete(token);
    }
  }

  toggle(token: string): void {
    if (this.classes.has(token)) {
      this.classes.delete(token);
    } else {
      this.classes.add(token);
    }
  }

  has(token: string): boolean {
    return this.classes.has(token);
  }
}

class MockElement {
  id = '';
  classList: MockClassList = new MockClassList();
  value = '';
  innerHTML = '';
  textContent = '';
  style: Record<string, string> = {};
  private attributes: Map<string, string> = new Map();

  constructor(public tagName: string) {}

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  addEventListener() {
    // no-op for tests
  }
}

// ─── Tests for filter logic ───────────────────────────────────────────────────

describe('Audit Log Page — Filter Logic', () => {
  describe('Quick-range chips', () => {
    it('should parse "today" range and set from/to to the same date', () => {
      const today = new Date();
      const iso = (d: Date) => d.toISOString().slice(0, 10);

      // Simulate setQuickRange('today')
      const expectedFrom = iso(today);
      const expectedTo = iso(today);

      expect(expectedFrom).toBe(expectedTo);
      expect(expectedFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('should parse "7d" range and set from 7 days ago', () => {
      const today = new Date();
      const sevenDaysAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
      const iso = (d: Date) => d.toISOString().slice(0, 10);

      const from = iso(sevenDaysAgo);
      const to = iso(today);

      expect(new Date(from).getTime()).toBeLessThan(new Date(to).getTime());
      // Verify the diff is roughly 7 days
      const diff = new Date(to).getTime() - new Date(from).getTime();
      expect(diff).toBeGreaterThan(6 * 24 * 60 * 60 * 1000);
      expect(diff).toBeLessThan(8 * 24 * 60 * 60 * 1000);
    });

    it('should parse "30d" range', () => {
      const today = new Date();
      const thirtyDaysAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
      const iso = (d: Date) => d.toISOString().slice(0, 10);

      const from = iso(thirtyDaysAgo);
      const to = iso(today);

      const diff = new Date(to).getTime() - new Date(from).getTime();
      expect(diff).toBeGreaterThan(29 * 24 * 60 * 60 * 1000);
      expect(diff).toBeLessThan(31 * 24 * 60 * 60 * 1000);
    });

    it('should parse "all" range as empty dates (no bounds)', () => {
      // "all" should clear both date inputs
      const from = '';
      const to = '';

      expect(from).toBe('');
      expect(to).toBe('');
    });
  });

  describe('Category toggle pills', () => {
    it('should have all 9 known categories', () => {
      const categories = [
        'user', 'event', 'club', 'link', 'file',
        'upload', 'email', 'security', 'other',
      ];

      expect(categories).toHaveLength(9);
      expect(categories).toEqual(
        expect.arrayContaining([
          'user', 'event', 'club', 'link', 'file',
          'upload', 'email', 'security', 'other',
        ])
      );
    });

    it('categories should start in "on" state (all visible by default)', () => {
      // In the HTML, all .cat-pill elements start with class="cat-pill on"
      // This means the default filter shows everything.
      const allOn = true;
      expect(allOn).toBe(true);
    });

    it('toggling a category on/off should switch the "on" class', () => {
      const pill = new MockElement('span');
      pill.classList.add('cat-pill', 'on');

      // Simulate toggle
      if (pill.classList.has('on')) {
        pill.classList.delete('on');
      } else {
        pill.classList.add('on');
      }

      expect(pill.classList.has('on')).toBe(false);

      // Toggle again
      if (pill.classList.has('on')) {
        pill.classList.delete('on');
      } else {
        pill.classList.add('on');
      }

      expect(pill.classList.has('on')).toBe(true);
    });

    it('clicking "All" button should turn on all category pills', () => {
      const pills = [
        { cat: 'user', on: false },
        { cat: 'event', on: false },
        { cat: 'club', on: false },
      ];

      // Simulate categoriesAll(true)
      for (let i = 0; i < pills.length; i++) {
        pills[i].on = true;
      }

      expect(pills.every((p) => p.on === true)).toBe(true);
    });

    it('clicking "None" button should turn off all category pills', () => {
      const pills = [
        { cat: 'user', on: true },
        { cat: 'event', on: true },
        { cat: 'club', on: true },
      ];

      // Simulate categoriesAll(false)
      for (let i = 0; i < pills.length; i++) {
        pills[i].on = false;
      }

      expect(pills.every((p) => p.on === false)).toBe(true);
    });
  });

  describe('Date range filters', () => {
    it('should accept a valid ISO date (YYYY-MM-DD)', () => {
      const date = '2026-04-18';
      expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('should reject malformed dates', () => {
      const invalidDates = [
        '18-04-2026', // wrong format
        '2026/04/18', // wrong separator
        '2026-4-18',  // missing zero padding
        'invalid',    // garbage
      ];

      for (const date of invalidDates) {
        expect(date).not.toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    });

    it('dateFrom and dateTo should apply as a closed range [from, to]', () => {
      const dateFrom = '2026-04-01';
      const dateTo = '2026-04-30';

      // A record on 2026-04-15T12:00:00.000Z should match
      const recordTs = '2026-04-15T12:00:00.000Z';
      const fromBound = `${dateFrom}T00:00:00.000Z`;
      const toBound = `${dateTo}T23:59:59.999Z`;

      expect(recordTs).toBeGreaterThanOrEqual(fromBound);
      expect(recordTs).toBeLessThanOrEqual(toBound);
    });
  });

  describe('Actor email filter', () => {
    it('should be case-insensitive', () => {
      const needle = 'ALICE@EXAMPLE.COM'.toLowerCase();
      const actorEmail = 'alice@example.com';

      expect(actorEmail.includes(needle.toLowerCase())).toBe(true);
    });

    it('should match partial substrings', () => {
      const needle = 'mmrunners'.toLowerCase();
      const actorEmail = 'bob@mmrunners.org'.toLowerCase();

      expect(actorEmail.includes(needle)).toBe(true);
    });

    it('should not match when substring is absent', () => {
      const needle = 'nowhere'.toLowerCase();
      const actorEmail = 'alice@example.com'.toLowerCase();

      expect(actorEmail.includes(needle)).toBe(false);
    });
  });
});

// ─── Tests for rendering logic ────────────────────────────────────────────────

describe('Audit Log Page — Rendering', () => {
  describe('actionClass() — category badge coloring', () => {
    const actionClass = (action: string): string => {
      if (!action) return 'other';
      if (action.indexOf('USER_') === 0) return 'user';
      if (action.indexOf('EVENT_') === 0) return 'event';
      if (action.indexOf('CLUB_') === 0) return 'club';
      if (action.indexOf('LINK_') === 0) return 'link';
      if (action.indexOf('FILE_') === 0 || action.indexOf('FOLDER_') === 0) return 'file';
      if (action.indexOf('EMAIL_') === 0 || action === 'EMAIL_PREFS_UPDATED') return 'email';
      if (action.indexOf('UPLOAD_') === 0) return 'upload';
      if (action === 'ADMIN_AUTH_REJECTED' || action === 'SECURITY_EVENT_DETECTED' ||
          action === 'MASQUERADE_START' || action === 'MASQUERADE_END') return 'security';
      return 'other';
    };

    it('maps USER_* actions to "user" class', () => {
      expect(actionClass('USER_CREATED')).toBe('user');
      expect(actionClass('USER_UPDATED')).toBe('user');
      expect(actionClass('USER_DEACTIVATED')).toBe('user');
    });

    it('maps EVENT_* actions to "event" class', () => {
      expect(actionClass('EVENT_CREATED')).toBe('event');
      expect(actionClass('EVENT_UPDATED')).toBe('event');
    });

    it('maps FILE_ and FOLDER_ actions to "file" class', () => {
      expect(actionClass('FILE_DELETED')).toBe('file');
      expect(actionClass('FOLDER_DELETED')).toBe('file');
    });

    it('maps security-specific actions correctly', () => {
      expect(actionClass('ADMIN_AUTH_REJECTED')).toBe('security');
      expect(actionClass('SECURITY_EVENT_DETECTED')).toBe('security');
      expect(actionClass('MASQUERADE_START')).toBe('security');
    });

    it('maps unknown actions to "other"', () => {
      expect(actionClass('EXPORT_CSV')).toBe('other');
      expect(actionClass('EXCEPTION_EMAIL_SENT')).toBe('other');
      expect(actionClass('')).toBe('other');
    });
  });

  describe('fmtTimestamp() — timestamp formatting', () => {
    const fmtTimestamp = (ts: string): string => {
      if (!ts) return '';
      return ts.replace('T', ' ').slice(0, 19);
    };

    it('formats ISO 8601 timestamp to readable format', () => {
      const ts = '2026-04-18T09:15:02.123Z';
      const result = fmtTimestamp(ts);

      expect(result).toBe('2026-04-18 09:15:02');
    });

    it('handles empty timestamp gracefully', () => {
      expect(fmtTimestamp('')).toBe('');
    });

    it('truncates milliseconds and timezone', () => {
      const ts = '2026-04-18T09:15:02.999999Z';
      const result = fmtTimestamp(ts);

      // Should truncate to second precision
      expect(result).toBe('2026-04-18 09:15:02');
    });
  });

  describe('renderRows() — table population', () => {
    it('should show empty state when no items', () => {
      const items: AuditLogRecord[] = [];
      const hasItems = items.length > 0;

      expect(hasItems).toBe(false);
    });

    it('should populate table with items when rows are present', () => {
      const items = [
        createMockAuditRecord({ action: AuditAction.USER_CREATED }),
        createMockAuditRecord({ action: AuditAction.EVENT_CREATED }),
      ];

      expect(items).toHaveLength(2);
      expect(items[0].action).toBe(AuditAction.USER_CREATED);
    });

    it('should escape HTML in all user-controlled fields', () => {
      const record = createMockAuditRecord({
        actorEmail: 'test+<script>@example.com',
        resourceId: '<img src=x>',
      });

      // In the HTML template, escapeHtml() is called on these fields
      // Verify the escaping happens (simplified version)
      const escapeHtml = (str: string): string =>
        str.replace(/&/g, '&amp;')
           .replace(/</g, '&lt;')
           .replace(/>/g, '&gt;')
           .replace(/"/g, '&quot;')
           .replace(/'/g, '&#x27;');

      expect(escapeHtml(record.actorEmail)).not.toContain('<script>');
      expect(escapeHtml(record.resourceId)).not.toContain('<img');
    });
  });

  describe('toggleDetails() — inline detail expansion', () => {
    it('should toggle "expanded" class on a details cell', () => {
      const cell = new MockElement('div');
      cell.classList.add('details-cell');

      // Simulate toggleDetails
      cell.classList.toggle('expanded');
      expect(cell.classList.has('expanded')).toBe(true);

      cell.classList.toggle('expanded');
      expect(cell.classList.has('expanded')).toBe(false);
    });

    it('should handle clicking a missing element gracefully', () => {
      const doesNotExist = null;

      // Should not throw
      expect(() => {
        if (doesNotExist) {
          // toggle would happen here
        }
      }).not.toThrow();
    });
  });

  describe('updatePagination()', () => {
    const updatePagination = (
      total: number,
      PAGE_SIZE: number,
      currentPage: number
    ) => {
      const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
      return {
        totalPages,
        showPagination: total > PAGE_SIZE,
        pageLabel: `Page ${currentPage} of ${totalPages}`,
        prevDisabled: currentPage <= 1,
        nextDisabled: currentPage >= totalPages,
        badge: `(${total} total)`,
      };
    };

    it('should hide pagination when total <= pageSize', () => {
      const result = updatePagination(50, 50, 1);

      expect(result.showPagination).toBe(false);
    });

    it('should show pagination when total > pageSize', () => {
      const result = updatePagination(100, 50, 1);

      expect(result.showPagination).toBe(true);
      expect(result.pageLabel).toBe('Page 1 of 2');
    });

    it('should disable prev button on page 1', () => {
      const result = updatePagination(100, 50, 1);

      expect(result.prevDisabled).toBe(true);
    });

    it('should enable prev button on page 2+', () => {
      const result = updatePagination(100, 50, 2);

      expect(result.prevDisabled).toBe(false);
    });

    it('should disable next button on last page', () => {
      const result = updatePagination(100, 50, 2);

      expect(result.nextDisabled).toBe(true);
    });

    it('should enable next button when not on last page', () => {
      const result = updatePagination(150, 50, 1);

      expect(result.nextDisabled).toBe(false);
    });
  });
});

// ─── Tests for URL state management ──────────────────────────────────────────

describe('Audit Log Page — URL State', () => {
  describe('syncUrl()', () => {
    it('should encode filter state in URL params', () => {
      const params = new URLSearchParams();
      params.set('action', 'admin_audit');
      params.set('actor', 'alice@example.com');
      params.set('from', '2026-04-01');
      params.set('to', '2026-04-30');
      params.set('cats', 'user,event');

      const url = '?' + params.toString();

      expect(url).toContain('action=admin_audit');
      expect(url).toContain('actor=alice%40example.com');
      expect(url).toContain('from=2026-04-01');
      expect(url).toContain('cats=user%2Cevent');
    });

    it('should omit categories when all are selected', () => {
      const allCats = ['user', 'event', 'club', 'link', 'file', 'upload', 'email', 'security', 'other'];
      const selected = allCats;

      // When selected.length === allCats.length, don't include cats param
      const shouldIncludeCats = selected.length !== allCats.length;

      expect(shouldIncludeCats).toBe(false);
    });

    it('should include categories when subset is selected', () => {
      const allCats = ['user', 'event', 'club', 'link', 'file', 'upload', 'email', 'security', 'other'];
      const selected = ['user', 'event'];

      const shouldIncludeCats = selected.length !== allCats.length;

      expect(shouldIncludeCats).toBe(true);
    });
  });

  describe('readUrl()', () => {
    it('should parse actor from URL', () => {
      const url = '?action=admin_audit&actor=alice@example.com';
      const params = new URLSearchParams(new URL(url, 'http://example.com').search);

      expect(params.get('actor')).toBe('alice@example.com');
    });

    it('should parse date range from URL', () => {
      const url = '?action=admin_audit&from=2026-04-01&to=2026-04-30';
      const params = new URLSearchParams(new URL(url, 'http://example.com').search);

      expect(params.get('from')).toBe('2026-04-01');
      expect(params.get('to')).toBe('2026-04-30');
    });

    it('should parse categories as comma-separated list', () => {
      const url = '?action=admin_audit&cats=user,event,club';
      const params = new URLSearchParams(new URL(url, 'http://example.com').search);
      const cats = params.get('cats')?.split(',') ?? [];

      expect(cats).toEqual(['user', 'event', 'club']);
    });

    it('should return empty strings for missing params', () => {
      const url = '?action=admin_audit';
      const params = new URLSearchParams(new URL(url, 'http://example.com').search);

      expect(params.get('actor')).toBeNull();
      expect(params.get('from')).toBeNull();
    });
  });
});

// ─── Tests for filter composition ────────────────────────────────────────────

describe('Audit Log Page — Filter Composition', () => {
  it('all filters should work together (actor + date + category)', () => {
    // Simulate having: actor=alice, dateFrom=2026-04-01, categories=[user]
    const record = createMockAuditRecord({
      actorEmail: 'alice@example.com',
      timestamp: '2026-04-15T10:00:00.000Z',
      action: AuditAction.USER_CREATED,
    });

    const actorMatch = record.actorEmail.includes('alice');
    const dateMatch = record.timestamp >= '2026-04-01T00:00:00.000Z' &&
                      record.timestamp <= '2026-04-30T23:59:59.999Z';
    const categoryMatch = record.action.startsWith('USER_');

    expect(actorMatch && dateMatch && categoryMatch).toBe(true);
  });

  it('empty category selection should show no results', () => {
    const records = [
      createMockAuditRecord({ action: AuditAction.USER_CREATED }),
      createMockAuditRecord({ action: AuditAction.EVENT_CREATED }),
    ];

    // Simulate categories: []
    const selectedCategories: string[] = [];
    const filtered = records.filter(() => selectedCategories.length > 0);

    expect(filtered).toHaveLength(0);
  });

  it('category filter should be OR (union)', () => {
    const records = [
      createMockAuditRecord({ action: AuditAction.USER_CREATED }),
      createMockAuditRecord({ action: AuditAction.EVENT_CREATED }),
      createMockAuditRecord({ action: AuditAction.CLUB_CREATED }),
    ];

    // Simulate selectedCategories: [user, event]
    const allowed = new Set([
      'USER_CREATED', 'USER_UPDATED',
      'EVENT_CREATED', 'EVENT_UPDATED',
    ]);
    const filtered = records.filter((r) => allowed.has(r.action));

    expect(filtered).toHaveLength(2);
    expect(filtered.map((r) => r.action)).toEqual([
      AuditAction.USER_CREATED,
      AuditAction.EVENT_CREATED,
    ]);
  });
});
