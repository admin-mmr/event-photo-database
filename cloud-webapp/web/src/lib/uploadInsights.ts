/**
 * uploadInsights.ts — the pivot behind the admin upload-insights page
 * (`pages/AdminUploadInsights.tsx`): formatting, the roll-up, grouping by any
 * order of club / tag / uploader, sorting and the visible-row walk. Pure, so
 * every number on the page is testable without rendering it.
 *
 * Every row is rolled up from the SESSIONS under it, never from the server's
 * per-uploader rows, so a club row is exactly the sum of what is beneath it
 * whichever way the rows are grouped. `rollUp` mirrors `addSession` +
 * `finishRow` in `api/src/services/uploadInsightsService.ts` — change both.
 */
import type { UploadInsightsGroup, UploadInsightsRow, UploadInsightsSession } from '@cloud-webapp/shared';

const MB = 1024 * 1024;

/** Human byte size. */
export function fmtBytes(bytes: number | null): string {
  if (bytes === null) return '—';
  if (bytes <= 0) return '0 MB';
  const mb = bytes / MB;
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** `95` → `1h 35m`; under an hour stays in minutes. */
export function fmtMinutes(minutes: number): string {
  const m = Math.round(minutes);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export const fmtPct = (ratio: number | null): string => (ratio === null ? '—' : `${Math.round(ratio * 100)}%`);
export const fmtRate = (v: number | null, digits: number): string => (v === null ? '—' : v.toFixed(digits));
export const fmtTime = (iso: string): string => (iso ? new Date(iso).toLocaleString() : '—');
export const fmtCount = (n: number): string => n.toLocaleString();

/** Total size of a row: what reached Drive plus what is still in staging. */
export const sizeOf = (r: UploadInsightsRow): number | null => (r.copiedBytes === null ? null : r.copiedBytes + r.stagedBytes);

// ── Roll-up ──────────────────────────────────────────────────────────────────

export type Dim = 'club' | 'tag' | 'uploader';
export const ALL_DIMS: readonly Dim[] = ['club', 'tag', 'uploader'];

/** A session with the (club, tag, uploader) the server filed it under. */
export interface PlacedSession {
  club: string;
  tag: string;
  uploader: string;
  session: UploadInsightsSession;
}

export function placeSessions(groups: ReadonlyArray<UploadInsightsGroup>): PlacedSession[] {
  return groups.flatMap((g) =>
    g.sessionList.map((session) => ({ club: g.clubName, tag: g.tag, uploader: g.uploader, session })),
  );
}

/**
 * Sum sessions into one row. Byte and index totals are null as soon as ANY
 * session's is unknown — a partial sum would read as a real, smaller number.
 */
export function rollUp(placed: ReadonlyArray<PlacedSession>, path: Partial<Record<Dim, string>> = {}): UploadInsightsRow {
  const row: UploadInsightsRow = {
    clubName: path.club ?? '',
    tag: path.tag ?? '',
    uploader: path.uploader ?? '',
    sessions: 0,
    files: 0,
    copied: 0,
    skippedDuplicates: 0,
    failed: 0,
    staged: 0,
    untracked: 0,
    copiedBytes: 0,
    stagedBytes: 0,
    minutes: 0,
    indexed: 0,
    indexRatio: null,
    mbPerSec: null,
    filesPerMin: null,
    inProgress: 0,
    stuck: 0,
    errors: 0,
    neverCompleted: 0,
    recovered: 0,
    firstSessionAt: '',
    lastSessionAt: '',
    lastActivityAt: '',
  };
  for (const { session: s } of placed) {
    row.sessions += 1;
    row.files += s.files;
    row.copied += s.copied;
    row.skippedDuplicates += s.skippedDuplicates;
    row.failed += s.failed;
    row.staged += s.staged;
    row.untracked += s.untracked;
    row.copiedBytes = row.copiedBytes === null || s.copiedBytes === null ? null : row.copiedBytes + s.copiedBytes;
    row.stagedBytes += s.stagedBytes;
    row.minutes += s.minutes;
    row.indexed = row.indexed === null || s.indexed === null ? null : row.indexed + s.indexed;
    if (s.status === 'in_progress') row.inProgress += 1;
    if (s.status === 'stuck') row.stuck += 1;
    if (s.status === 'error') row.errors += 1;
    if (s.status === 'never_completed') row.neverCompleted += 1;
    if (s.recovered) row.recovered += 1;
    if (s.startedAt && (!row.firstSessionAt || s.startedAt < row.firstSessionAt)) row.firstSessionAt = s.startedAt;
    if (s.startedAt > row.lastSessionAt) row.lastSessionAt = s.startedAt;
    if (s.lastActivityAt > row.lastActivityAt) row.lastActivityAt = s.lastActivityAt;
  }
  row.minutes = Math.round(row.minutes * 10) / 10;
  // Not-counted files reached Drive too (see the schema), so they count as copied.
  const inDrive = row.copied + row.untracked;
  row.indexRatio = row.indexed !== null && inDrive > 0 ? row.indexed / inDrive : null;
  const seconds = row.minutes * 60;
  row.mbPerSec = row.copiedBytes !== null && seconds > 0 ? row.copiedBytes / MB / seconds : null;
  row.filesPerMin = row.minutes > 0 ? row.copied / row.minutes : null;
  return row;
}

// ── Pivot tree ───────────────────────────────────────────────────────────────

export interface PivotNode {
  /** Unique in the tree, and stable for the same grouping (expand state keys on it). */
  key: string;
  /** Which dimension this row is; a session row is the drill-down below the last one. */
  kind: Dim | 'session' | 'total';
  /** 0 for the first dimension; sessions sit one below the last; the total is -1. */
  depth: number;
  /** The dimension's value; for a session, its batchId. */
  label: string;
  path: Partial<Record<Dim, string>>;
  metrics: UploadInsightsRow;
  /** Sub-groups (the next dimension); empty on the last one. */
  children: PivotNode[];
  /** Every session under this row. */
  placed: PlacedSession[];
  session?: UploadInsightsSession;
}

const valueOf = (p: PlacedSession, dim: Dim): string => (dim === 'club' ? p.club : dim === 'tag' ? p.tag : p.uploader);

function groupNodes(placed: ReadonlyArray<PlacedSession>, dims: ReadonlyArray<Dim>, depth: number, parent: PivotNode['path']): PivotNode[] {
  const dim = dims[depth];
  if (!dim) return [];
  const byValue = new Map<string, PlacedSession[]>();
  for (const p of placed) {
    const v = valueOf(p, dim);
    const list = byValue.get(v);
    if (list) list.push(p);
    else byValue.set(v, [p]);
  }
  return [...byValue].map(([value, list]) => {
    const path = { ...parent, [dim]: value };
    return {
      key: JSON.stringify(dims.slice(0, depth + 1).map((d) => path[d])),
      kind: dim,
      depth,
      label: value,
      path,
      metrics: rollUp(list, path),
      children: groupNodes(list, dims, depth + 1, path),
      placed: list,
    };
  });
}

/**
 * Rows grouped by `dims` in order, under one `total` node; each level is rolled
 * up from its sessions.
 */
export function buildPivot(groups: ReadonlyArray<UploadInsightsGroup>, dims: ReadonlyArray<Dim>): PivotNode {
  const placed = placeSessions(groups);
  return {
    key: '#total',
    kind: 'total',
    depth: -1,
    label: '',
    path: {},
    metrics: rollUp(placed),
    children: groupNodes(placed, dims, 0, {}),
    placed,
  };
}

/** A group's sessions as rows of their own, one level below the group. */
export function sessionNodes(node: PivotNode): PivotNode[] {
  return node.placed.map((p) => {
    const path = { club: p.club, tag: p.tag, uploader: p.uploader };
    return {
      key: `${node.key}#${p.session.batchId}`,
      kind: 'session',
      depth: node.depth + 1,
      label: p.session.batchId,
      path,
      metrics: rollUp([p], path),
      children: [],
      placed: [p],
      session: p.session,
    };
  });
}

/** Every group key in the tree — "collapse all" collapses each of them. */
export function allGroupKeys(rows: ReadonlyArray<PivotNode>): string[] {
  return rows.flatMap((n) => [n.key, ...allGroupKeys(n.children)]);
}

// ── Sorting ──────────────────────────────────────────────────────────────────

export type SortKey =
  | 'label'
  | 'attention'
  | 'sessions'
  | 'files'
  | 'copied'
  | 'untracked'
  | 'skippedDuplicates'
  | 'staged'
  | 'failed'
  | 'indexed'
  | 'indexRatio'
  | 'size'
  | 'minutes'
  | 'firstSessionAt'
  | 'lastSessionAt'
  | 'lastActivityAt'
  | 'mbPerSec'
  | 'filesPerMin';

/** Problems first when sorted by attention: stuck and errors outrank the rest. */
export const attentionScore = (r: UploadInsightsRow): number =>
  r.stuck * 1000 + r.errors * 1000 + r.neverCompleted * 100 + (r.staged > 0 ? 10 : 0) + r.inProgress;

function sortValue(n: PivotNode, key: SortKey): string | number | null {
  // A session's own label is its id; its start time is the order that means something.
  if (key === 'label') return n.session ? n.session.startedAt : n.label;
  if (key === 'size') return sizeOf(n.metrics);
  if (key === 'attention') return attentionScore(n.metrics);
  return n.metrics[key];
}

/** Sort one level; nulls (unknown) always last whichever the direction. */
export function sortNodes(nodes: ReadonlyArray<PivotNode>, key: SortKey, dir: 'asc' | 'desc'): PivotNode[] {
  const sign = dir === 'asc' ? 1 : -1;
  return [...nodes].sort((a, b) => {
    const va = sortValue(a, key);
    const vb = sortValue(b, key);
    if (va === null || vb === null) return va === vb ? 0 : va === null ? 1 : -1;
    if (typeof va === 'string' || typeof vb === 'string') return sign * String(va).localeCompare(String(vb));
    return sign * (va - vb);
  });
}

/**
 * The rows on screen, top to bottom: each level sorted within its parent,
 * children hidden under a collapsed group, sessions shown under an opened one.
 */
export function visibleRows(
  rows: ReadonlyArray<PivotNode>,
  opts: { collapsed: ReadonlySet<string>; sessionsOpen: ReadonlySet<string>; key: SortKey; dir: 'asc' | 'desc' },
): PivotNode[] {
  const out: PivotNode[] = [];
  const walk = (level: ReadonlyArray<PivotNode>): void => {
    for (const n of sortNodes(level, opts.key, opts.dir)) {
      out.push(n);
      if (n.children.length > 0) {
        if (!opts.collapsed.has(n.key)) walk(n.children);
      } else if (opts.sessionsOpen.has(n.key)) {
        out.push(...sortNodes(sessionNodes(n), opts.key, opts.dir));
      }
    }
  };
  walk(rows);
  return out;
}

// ── Saved layout ─────────────────────────────────────────────────────────────

export type ColumnId = Exclude<SortKey, 'label'>;

export const ALL_COLUMNS: readonly ColumnId[] = [
  'attention',
  'sessions',
  'files',
  'copied',
  'untracked',
  'skippedDuplicates',
  'staged',
  'failed',
  'indexed',
  'indexRatio',
  'size',
  'minutes',
  'firstSessionAt',
  'lastSessionAt',
  'lastActivityAt',
  'mbPerSec',
  'filesPerMin',
];

/** What a first visit shows; the rest are one tick away in the column picker. */
export const DEFAULT_COLUMNS: readonly ColumnId[] = [
  'attention',
  'sessions',
  'files',
  'copied',
  'untracked',
  'skippedDuplicates',
  'staged',
  'indexRatio',
  'size',
  'minutes',
  'lastSessionAt',
  'mbPerSec',
];

export interface InsightsLayout {
  dims: Dim[];
  columns: ColumnId[];
}

const LAYOUT_KEY = 'admin.uploadInsights.layout';

export const defaultLayout = (): InsightsLayout => ({ dims: [...ALL_DIMS], columns: [...DEFAULT_COLUMNS] });

/** The saved layout, with anything unknown dropped; the default when there is none. */
export function readLayout(): InsightsLayout {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? 'null');
    if (raw && typeof raw === 'object') {
      const r = raw as { dims?: unknown; columns?: unknown };
      const savedDims: unknown[] = Array.isArray(r.dims) ? r.dims : [];
      const savedColumns: unknown[] = Array.isArray(r.columns) ? r.columns : [...DEFAULT_COLUMNS];
      const dims = [...new Set(savedDims.filter((d): d is Dim => ALL_DIMS.includes(d as Dim)))];
      const columns = ALL_COLUMNS.filter((c) => savedColumns.includes(c));
      if (dims.length > 0) return { dims, columns };
    }
  } catch {
    /* storage unavailable or unreadable — use the default */
  }
  return defaultLayout();
}

export function saveLayout(layout: InsightsLayout): void {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    /* storage unavailable (private mode) — the layout just isn't remembered */
  }
}

/** `Nov 1, 11:21 PM` — a session's start, short enough for a frozen label column. */
export const fmtShortTime = (iso: string): string =>
  iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';
