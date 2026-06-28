import { describe, it, expect } from 'vitest';

import {
  buildPhotoFolderRows,
  buildVideoFolderRows,
  buildClubAlbumTabs,
  sanitizeTabName,
  type EventInfo,
} from '../src/services/publicFolderIndexService.js';
import type { SpecialFolderRecord } from '../src/services/specialFoldersStore.js';
import type { Club } from '../src/services/clubStore.js';

const ev = (eventId: string, eventDate: string, eventName: string): EventInfo => ({ eventId, eventDate, eventName });
const rec = (p: Partial<SpecialFolderRecord>): SpecialFolderRecord => ({
  folderId: 'f',
  eventId: 'e1',
  scope: 'photos',
  clubName: '',
  tag: '',
  folderName: 'Photos_001',
  folderIndex: 1,
  folderUrl: 'https://drive/f',
  fileCount: 3,
  lastRefreshedAt: '2026-06-01T00:00:00Z',
  ...p,
});
const club = (normalizedName: string, displayName: string): Club =>
  ({ normalizedName, displayName } as Club);

describe('buildPhotoFolderRows', () => {
  it('keeps only photos, joins events, sorts newest-first then bucket index', () => {
    const events = [ev('e1', '2026-06-01', 'Old'), ev('e2', '2026-06-10', 'New')];
    const records = [
      rec({ eventId: 'e1', folderName: 'Photos_002', folderIndex: 2 }),
      rec({ eventId: 'e1', folderName: 'Photos_001', folderIndex: 1 }),
      rec({ eventId: 'e2', folderName: 'Photos_001', folderIndex: 1 }),
      rec({ eventId: 'e1', scope: 'videos', folderName: 'Videos' }),
    ];
    const rows = buildPhotoFolderRows(records, events);
    expect(rows).toHaveLength(3); // videos excluded
    expect(rows[0]![1]).toBe('New'); // newest event first
    expect(rows[1]![2]).toBe('Photos_001'); // then ascending bucket index
    expect(rows[2]![2]).toBe('Photos_002');
  });

  it('drops rows whose event is unknown', () => {
    expect(buildPhotoFolderRows([rec({ eventId: 'ghost' })], [])).toHaveLength(0);
  });
});

describe('buildVideoFolderRows', () => {
  it('resolves club display name, falls back to normalized', () => {
    const events = [ev('e1', '2026-06-01', 'Race')];
    const clubs = [club('lanshan', '岚山')];
    const records = [
      rec({ scope: 'videos', clubName: 'lanshan', tag: 'cam1', folderName: 'Videos' }),
      rec({ scope: 'videos', clubName: 'unknown_club', tag: '', folderName: 'Videos' }),
    ];
    const rows = buildVideoFolderRows(records, events, clubs);
    const clubLabels = rows.map((r) => r[2]);
    expect(clubLabels).toContain('岚山');
    expect(clubLabels).toContain('unknown_club');
  });
});

describe('buildClubAlbumTabs', () => {
  it('groups albums into one tab per club using display name', () => {
    const events = [ev('e1', '2026-06-01', 'Race')];
    const clubs = [club('lanshan', '岚山')];
    const records = [
      rec({ scope: 'albums', clubName: 'lanshan', tag: 't1', folderName: 'Album' }),
      rec({ scope: 'albums', clubName: 'lanshan', tag: 't2', folderName: 'Album' }),
    ];
    const tabs = buildClubAlbumTabs(records, events, clubs);
    expect(tabs).toHaveLength(1);
    expect(tabs[0]!.tabName).toBe('岚山');
    expect(tabs[0]!.rows).toHaveLength(2);
  });
});

describe('sanitizeTabName', () => {
  it('strips forbidden chars and falls back to Club', () => {
    expect(sanitizeTabName('A/B:C')).toBe('A B C');
    expect(sanitizeTabName('   ')).toBe('Club');
  });
});
