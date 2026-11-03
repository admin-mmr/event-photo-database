import { describe, it, expect } from 'vitest';
import type { UploadInsightsRow } from '@cloud-webapp/shared';

import { fmtBytes, fmtMinutes, sortRows } from './uploadInsights.js';

const row = (over: Partial<UploadInsightsRow>): UploadInsightsRow => ({
  clubName: 'MMR',
  tag: 'ALL',
  uploader: 'jane',
  sessions: 1,
  files: 1,
  copied: 1,
  skippedDuplicates: 0,
  failed: 0,
  staged: 0,
  untracked: 0,
  copiedBytes: 0,
  stagedBytes: 0,
  minutes: 1,
  indexed: 1,
  indexRatio: 1,
  mbPerSec: 1,
  filesPerMin: 1,
  inProgress: 0,
  stuck: 0,
  errors: 0,
  neverCompleted: 0,
  recovered: 0,
  firstSessionAt: '',
  lastSessionAt: '',
  lastActivityAt: '',
  ...over,
});

describe('upload insights formatting', () => {
  it('formats sizes and durations', () => {
    expect(fmtBytes(null)).toBe('—');
    expect(fmtBytes(0)).toBe('0 MB');
    expect(fmtBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(fmtBytes(3 * 1024 ** 3)).toBe('3.0 GB');
    expect(fmtMinutes(42.4)).toBe('42 min');
    expect(fmtMinutes(95)).toBe('1h 35m');
  });
});

describe('sortRows', () => {
  it('sorts numbers and strings both ways', () => {
    const rows = [row({ uploader: 'bob', files: 5 }), row({ uploader: 'amy', files: 50 })];
    expect(sortRows(rows, 'files', 'desc').map((r) => r.files)).toEqual([50, 5]);
    expect(sortRows(rows, 'uploader', 'asc').map((r) => r.uploader)).toEqual(['amy', 'bob']);
  });

  it('keeps unknown values last in either direction', () => {
    const rows = [row({ uploader: 'x', indexRatio: null }), row({ uploader: 'y', indexRatio: 0.2 }), row({ uploader: 'z', indexRatio: 0.9 })];
    expect(sortRows(rows, 'indexRatio', 'asc').map((r) => r.uploader)).toEqual(['y', 'z', 'x']);
    expect(sortRows(rows, 'indexRatio', 'desc').map((r) => r.uploader)).toEqual(['z', 'y', 'x']);
  });

  it('puts stuck and errored uploaders first when sorted by attention', () => {
    const rows = [
      row({ uploader: 'fine' }),
      row({ uploader: 'staged', staged: 3 }),
      row({ uploader: 'stuck', stuck: 1 }),
      row({ uploader: 'never', neverCompleted: 1 }),
    ];
    expect(sortRows(rows, 'attention', 'desc').map((r) => r.uploader)).toEqual(['stuck', 'never', 'staged', 'fine']);
  });

  it('sorts size by copied + staged bytes', () => {
    const rows = [row({ uploader: 'a', copiedBytes: 10, stagedBytes: 0 }), row({ uploader: 'b', copiedBytes: 1, stagedBytes: 20 })];
    expect(sortRows(rows, 'size', 'desc').map((r) => r.uploader)).toEqual(['b', 'a']);
  });
});
