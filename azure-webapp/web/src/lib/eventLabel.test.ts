import { describe, it, expect } from 'vitest';
import { eventLabel } from './eventLabel.js';

describe('eventLabel (B5)', () => {
  it('uses the name when present', () => {
    expect(eventLabel({ name: 'Spring Run 2026', id: 'ev1', hasPhotos: true })).toBe('Spring Run 2026');
  });

  it('never renders "Untitled event" for an event that has photos', () => {
    const withDate = eventLabel({ name: '', date: '2026-06-01', id: 'ev1', hasPhotos: true });
    expect(withDate).not.toMatch(/Untitled/);
    expect(withDate).toBe('Event · 2026-06-01');

    const noDate = eventLabel({ name: '', id: 'abcdef123456', hasPhotos: true });
    expect(noDate).not.toMatch(/Untitled/);
    expect(noDate).toBe('Event abcdef');
  });

  it('falls back to "Untitled event" only for a nameless, photoless, dateless event', () => {
    expect(eventLabel({ name: '', id: 'ev1', hasPhotos: false })).toBe('Untitled event');
  });

  it('trims whitespace-only names', () => {
    expect(eventLabel({ name: '   ', date: '2026-06-01', id: 'ev1', hasPhotos: false })).toBe(
      'Event · 2026-06-01',
    );
  });
});
