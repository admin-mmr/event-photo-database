import { describe, it, expect, beforeEach } from 'vitest';
import type { UploadInsightsGroup, UploadInsightsSession } from '@cloud-webapp/shared';

import {
  ALL_DIMS,
  DEFAULT_COLUMNS,
  allGroupKeys,
  buildPivot,
  fmtBytes,
  fmtMinutes,
  placeSessions,
  readLayout,
  rollUp,
  saveLayout,
  sortNodes,
  visibleRows,
  type Dim,
  type PivotNode,
} from './uploadInsights.js';

const MB = 1024 * 1024;

const session = (batchId: string, over: Partial<UploadInsightsSession> = {}): UploadInsightsSession => ({
  batchId,
  status: 'ok',
  batchFolders: [`20261101-140000_${batchId}`],
  files: 10,
  copied: 10,
  skippedDuplicates: 0,
  failed: 0,
  staged: 0,
  untracked: 0,
  copiedBytes: 10 * MB,
  stagedBytes: 0,
  indexed: 10,
  startedAt: '2026-11-01T14:00:00.000Z',
  lastActivityAt: '2026-11-01T14:10:00.000Z',
  minutes: 10,
  recovered: false,
  ...over,
});

/** Only `sessionList` and the (club, tag, uploader) matter: rows are rolled up from sessions. */
const group = (clubName: string, tag: string, uploader: string, sessionList: UploadInsightsSession[]): UploadInsightsGroup => ({
  ...rollUp([]),
  clubName,
  tag,
  uploader,
  sessionList,
});

const GROUPS: UploadInsightsGroup[] = [
  group('MMR', 'NYC', 'jane', [session('s1')]),
  group('MMR', 'ALL', 'bob', [
    session('s2', { status: 'stuck', copied: 4, staged: 6, stagedBytes: 6 * MB, copiedBytes: 4 * MB, indexed: 4, startedAt: '2026-11-02T09:00:00.000Z' }),
  ]),
  group('Harriers', 'ALL', 'bob', [
    // A retried session: 1236 files copied by a killed first attempt, never counted.
    session('s3', { files: 5133, copied: 3755, skippedDuplicates: 142, untracked: 1236, indexed: 4991, minutes: 100, startedAt: '2026-11-01T20:00:00.000Z' }),
  ]),
];

const SUMMED = ['sessions', 'files', 'copied', 'untracked', 'skippedDuplicates', 'staged', 'failed', 'stagedBytes', 'stuck'] as const;

/** Every grouping order of every non-empty subset of the dimensions. */
function allOrders(): Dim[][] {
  const out: Dim[][] = [];
  const grow = (prefix: Dim[]): void => {
    if (prefix.length > 0) out.push(prefix);
    for (const d of ALL_DIMS) if (!prefix.includes(d)) grow([...prefix, d]);
  };
  grow([]);
  return out;
}

describe('upload insights formatting', () => {
  it('formats sizes and durations', () => {
    expect(fmtBytes(null)).toBe('—');
    expect(fmtBytes(0)).toBe('0 MB');
    expect(fmtBytes(5 * MB)).toBe('5.0 MB');
    expect(fmtBytes(3 * 1024 ** 3)).toBe('3.0 GB');
    expect(fmtMinutes(42.4)).toBe('42 min');
    expect(fmtMinutes(95)).toBe('1h 35m');
  });
});

describe('rollUp', () => {
  it('sums sessions so the parts add up to Files', () => {
    const r = rollUp(placeSessions(GROUPS));
    expect(r.sessions).toBe(3);
    expect(r.files).toBe(10 + 10 + 5133);
    expect(r.copied + r.untracked + r.skippedDuplicates + r.staged).toBe(r.files);
    expect(r.stuck).toBe(1);
    expect(r.firstSessionAt).toBe('2026-11-01T14:00:00.000Z');
    expect(r.lastSessionAt).toBe('2026-11-02T09:00:00.000Z');
  });

  it('counts not-counted files as in Drive for Index %', () => {
    const r = rollUp(placeSessions([GROUPS[2] as UploadInsightsGroup]));
    expect(r.indexRatio).toBe(4991 / (3755 + 1236));
  });

  it('is unknown, not smaller, when any session is unknown', () => {
    const r = rollUp(placeSessions([group('A', 'ALL', 'x', [session('a'), session('b', { copiedBytes: null, indexed: null })])]));
    expect(r.copiedBytes).toBeNull();
    expect(r.indexed).toBeNull();
    expect(r.indexRatio).toBeNull();
    expect(r.mbPerSec).toBeNull();
  });
});

describe('buildPivot', () => {
  it('every row is the sum of the rows beneath it, in every grouping order', () => {
    const check = (n: PivotNode): void => {
      if (n.children.length === 0) return;
      for (const k of SUMMED) {
        expect(n.children.reduce((a, c) => a + c.metrics[k], 0), `${n.key} ${k}`).toBe(n.metrics[k]);
      }
      n.children.forEach(check);
    };
    for (const dims of allOrders()) {
      const total = buildPivot(GROUPS, dims);
      expect(total.metrics.files).toBe(5153);
      check(total);
    }
  });

  it('merges one uploader across clubs when grouped by uploader alone', () => {
    const rows = buildPivot(GROUPS, ['uploader']).children;
    const bob = rows.find((n) => n.label === 'bob') as PivotNode;
    expect(rows).toHaveLength(2);
    expect(bob.metrics.sessions).toBe(2);
    expect(bob.metrics.files).toBe(5143);
    expect(bob.children).toEqual([]);
  });

  it('nests in the chosen order', () => {
    const rows = buildPivot(GROUPS, ['tag', 'club']).children;
    const all = rows.find((n) => n.label === 'ALL') as PivotNode;
    expect(all.kind).toBe('tag');
    expect(all.children.map((c) => c.label).sort()).toEqual(['Harriers', 'MMR']);
    expect(all.children.every((c) => c.kind === 'club' && c.depth === 1)).toBe(true);
  });
});

describe('visibleRows', () => {
  const tree = buildPivot(GROUPS, ['club', 'uploader']).children;
  const labels = (rows: PivotNode[]): string[] => rows.map((n) => (n.session ? `#${n.session.batchId}` : n.label));

  it('shows every group, children sorted within their parent', () => {
    const rows = visibleRows(tree, { collapsed: new Set(), sessionsOpen: new Set(), key: 'staged', dir: 'desc' });
    expect(labels(rows)).toEqual(['MMR', 'bob', 'jane', 'Harriers', 'bob']);
  });

  it('hides a collapsed group and opens a leaf onto its sessions', () => {
    const harriers = tree.find((n) => n.label === 'Harriers') as PivotNode;
    const mmr = tree.find((n) => n.label === 'MMR') as PivotNode;
    const jane = mmr.children.find((n) => n.label === 'jane') as PivotNode;
    const rows = visibleRows(tree, {
      collapsed: new Set([harriers.key]),
      sessionsOpen: new Set([jane.key]),
      key: 'label',
      dir: 'asc',
    });
    expect(labels(rows)).toEqual(['Harriers', 'MMR', 'bob', 'jane', '#s1']);
    const s1 = rows[4] as PivotNode;
    expect(s1.kind).toBe('session');
    expect(s1.metrics.sessions).toBe(1);
  });

  it('collapse-all keys cover every group level', () => {
    const keys = new Set(allGroupKeys(tree));
    expect(keys.size).toBe(5);
    expect(labels(visibleRows(tree, { collapsed: keys, sessionsOpen: new Set(), key: 'label', dir: 'asc' }))).toEqual([
      'Harriers',
      'MMR',
    ]);
  });
});

describe('sortNodes', () => {
  const rows = buildPivot(
    [
      group('A', 'ALL', 'x', [session('x', { indexed: null })]),
      group('B', 'ALL', 'y', [session('y', { indexed: 2 })]),
      group('C', 'ALL', 'z', [session('z', { indexed: 9, staged: 1, files: 11 })]),
      group('D', 'ALL', 'w', [session('w', { status: 'stuck' })]),
    ],
    ['club'],
  ).children;

  it('keeps unknown values last in either direction', () => {
    expect(sortNodes(rows, 'indexRatio', 'asc').map((n) => n.label)).toEqual(['B', 'C', 'D', 'A']);
    expect(sortNodes(rows, 'indexRatio', 'desc').map((n) => n.label)).toEqual(['D', 'C', 'B', 'A']);
  });

  it('puts problems first when sorted by attention', () => {
    expect(sortNodes(rows, 'attention', 'desc').map((n) => n.label).slice(0, 2)).toEqual(['D', 'C']);
  });
});

describe('layout', () => {
  beforeEach(() => localStorage.clear());

  it('defaults to club › tag › uploader with the default columns', () => {
    expect(readLayout()).toEqual({ dims: ['club', 'tag', 'uploader'], columns: [...DEFAULT_COLUMNS] });
  });

  it('remembers the grouping order and the columns', () => {
    saveLayout({ dims: ['uploader', 'club'], columns: ['files', 'sessions'] });
    // Columns come back in table order, whatever order they were ticked in.
    expect(readLayout()).toEqual({ dims: ['uploader', 'club'], columns: ['sessions', 'files'] });
  });

  it('drops anything it does not know', () => {
    localStorage.setItem('admin.uploadInsights.layout', JSON.stringify({ dims: ['club', 'nope', 'club'], columns: ['x', 'files'] }));
    expect(readLayout()).toEqual({ dims: ['club'], columns: ['files'] });
    localStorage.setItem('admin.uploadInsights.layout', '{not json');
    expect(readLayout().dims).toEqual(['club', 'tag', 'uploader']);
  });
});
