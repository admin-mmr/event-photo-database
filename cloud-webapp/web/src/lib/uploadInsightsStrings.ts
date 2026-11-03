/**
 * Strings for the upload-insights page and its detail panel / column picker —
 * one catalog, since all three name the same columns.
 */
import type { UploadSessionStatus } from '@cloud-webapp/shared';
import { fmtShortTime, type ColumnId, type Dim, type PivotNode } from './uploadInsights.js';

export interface InsightsStrings {
  title: string;
  intro: string;
  forbidden: string;
  eventLabel: string;
  loadingEvents: string;
  choose: string;
  refresh: string;
  loading: string;
  loadError: string;
  exportCsv: string;
  noUploads: string;
  noIndexCounts: string;
  indexCountsAt: (when: string) => string;
  rows: string;
  dim: Record<Dim, string>;
  moveEarlier: (dim: string) => string;
  removeDim: (dim: string) => string;
  addDim: (dim: string) => string;
  expandAll: string;
  collapseAll: string;
  columns: (shown: number, of: number) => string;
  showAll: string;
  reset: string;
  columnGroup: { files: string; index: string; time: string; speed: string; status: string };
  col: Record<ColumnId, string>;
  hint: Partial<Record<ColumnId, string>>;
  total: string;
  unnamed: string;
  expand: (label: string) => string;
  collapse: (label: string) => string;
  showSessions: (label: string) => string;
  hideSessions: (label: string) => string;
  openDetails: (label: string) => string;
  statusLabel: Record<UploadSessionStatus, string>;
  stuckBadge: (n: number) => string;
  errorBadge: (n: number) => string;
  neverBadge: (n: number) => string;
  copyingBadge: (n: number) => string;
  recoveredBadge: (n: number) => string;
  allEvent: string;
  session: string;
  close: string;
  back: (label: string) => string;
  whereFiles: string;
  equation: (files: string, copied: string, untracked: string, dups: string, staged: string) => string;
  legend: { copied: string; untracked: string; dups: string; staged: string };
  untrackedNote: string;
  failedNote: (n: string) => string;
  indexBlock: string;
  indexedOf: (indexed: string, inDrive: string) => string;
  sizeBlock: string;
  copiedSize: string;
  stagedSize: string;
  timeBlock: string;
  speedBlock: string;
  sessionsBlock: string;
  moreSessions: (n: number) => string;
  sessionId: string;
  folders: string;
  recoveredNote: string;
}

const en: InsightsStrings = {
  title: 'Upload insights',
  intro:
    'Choose how rows are grouped. Every row adds up the sessions beneath it, so subtotals always match. Click a row for its full breakdown.',
  forbidden: 'Upload insights are admin-only — sign in with an admin account.',
  eventLabel: 'Event',
  loadingEvents: 'Loading events…',
  choose: 'Choose an event…',
  refresh: 'Refresh',
  loading: 'Loading…',
  loadError: 'Could not load upload insights.',
  exportCsv: 'Export CSV',
  noUploads: 'No uploads recorded for this event.',
  noIndexCounts: 'Index % appears after the event is next indexed.',
  indexCountsAt: (when) => `Index counts as of ${when}.`,
  rows: 'Rows',
  dim: { club: 'Club', tag: 'Tag', uploader: 'Uploader' },
  moveEarlier: (d) => `Move ${d} earlier`,
  removeDim: (d) => `Stop grouping by ${d}`,
  addDim: (d) => `Group by ${d}`,
  expandAll: 'Expand all',
  collapseAll: 'Collapse all',
  columns: (n, of) => `Columns · ${n} of ${of}`,
  showAll: 'Show all',
  reset: 'Reset',
  columnGroup: { files: 'Files', index: 'Index', time: 'Size & time', speed: 'Speed', status: 'Status' },
  col: {
    attention: 'Needs attention',
    sessions: 'Sessions',
    files: 'Files',
    copied: 'Copied',
    untracked: 'Not counted',
    skippedDuplicates: 'Duplicates',
    staged: 'In staging',
    failed: 'Failed',
    indexed: 'Indexed',
    indexRatio: 'Index %',
    size: 'Size',
    minutes: 'Upload time',
    firstSessionAt: 'First session',
    lastSessionAt: 'Last session',
    lastActivityAt: 'Last activity',
    mbPerSec: 'MB/s',
    filesPerMin: 'Files/min',
  },
  hint: {
    untracked:
      'No copy result was recorded for these files. Almost always a retried copy: the first attempt copied them to Drive, then died before saving its counts, and the retry skipped them. Index % confirms they are in Drive.',
    failed: 'Failed copy attempts. Those files stay in staging or were copied later, so they are not part of Files.',
    indexRatio: 'Indexed photos ÷ files in Drive (copied + not counted). Videos are never indexed.',
    size: 'Copied to Drive + still in staging.',
    minutes: 'Sum of session durations, first contact to last copy activity. Parallel sessions overlap, so this can exceed clock time.',
    attention: 'Sessions that are stuck, failed, never completed or still copying.',
  },
  total: 'Total',
  unnamed: '(no name yet)',
  expand: (l) => `Expand ${l}`,
  collapse: (l) => `Collapse ${l}`,
  showSessions: (l) => `Show sessions for ${l}`,
  hideSessions: (l) => `Hide sessions for ${l}`,
  openDetails: (l) => `Details for ${l}`,
  statusLabel: { ok: 'done', in_progress: 'copying', stuck: 'stuck', error: 'error', never_completed: 'never completed' },
  stuckBadge: (n) => `${n} stuck`,
  errorBadge: (n) => `${n} error`,
  neverBadge: (n) => `${n} never completed`,
  copyingBadge: (n) => `${n} copying`,
  recoveredBadge: (n) => `${n} recovered`,
  allEvent: 'Whole event',
  session: 'Session',
  close: 'Close',
  back: (l) => `Back to ${l}`,
  whereFiles: 'Where the files went',
  equation: (f, c, u, d, s) => `${f} files = ${c} copied + ${u} not counted + ${d} duplicates + ${s} in staging`,
  legend: { copied: 'Copied to Drive', untracked: 'Not counted', dups: 'Duplicates skipped', staged: 'Still in staging' },
  untrackedNote:
    'Not counted: copied by an earlier attempt of a retried chunk, which died before saving its counts. They are in Drive.',
  failedNote: (n) => `${n} failed copy attempts — those files stay in staging or were copied later.`,
  indexBlock: 'Find-Me index',
  indexedOf: (i, d) => `${i} of ${d} files in Drive are indexed`,
  sizeBlock: 'Size',
  copiedSize: 'Copied to Drive',
  stagedSize: 'Still in staging',
  timeBlock: 'Time',
  speedBlock: 'Speed',
  sessionsBlock: 'Sessions',
  moreSessions: (n) => `Show all ${n}`,
  sessionId: 'Session id',
  folders: 'Drive folder',
  recoveredNote: 'Re-dispatched by upload recovery.',
};

const zh: InsightsStrings = {
  title: '上传洞察',
  intro: '选择行的分组方式。每一行都是其下所有会话的合计，因此小计始终一致。点击某行查看完整明细。',
  forbidden: '上传洞察仅限管理员，请使用管理员账号登录。',
  eventLabel: '活动',
  loadingEvents: '正在加载活动…',
  choose: '选择活动…',
  refresh: '刷新',
  loading: '加载中…',
  loadError: '无法加载上传洞察。',
  exportCsv: '导出 CSV',
  noUploads: '此活动暂无上传记录。',
  noIndexCounts: '下次索引该活动后将显示索引 %。',
  indexCountsAt: (when) => `索引计数截至 ${when}。`,
  rows: '行',
  dim: { club: '俱乐部', tag: '标签', uploader: '上传者' },
  moveEarlier: (d) => `将${d}前移`,
  removeDim: (d) => `取消按${d}分组`,
  addDim: (d) => `按${d}分组`,
  expandAll: '全部展开',
  collapseAll: '全部折叠',
  columns: (n, of) => `列 · ${n}/${of}`,
  showAll: '全部显示',
  reset: '重置',
  columnGroup: { files: '文件', index: '索引', time: '大小与时间', speed: '速度', status: '状态' },
  col: {
    attention: '需要关注',
    sessions: '会话',
    files: '文件',
    copied: '已复制',
    untracked: '未计数',
    skippedDuplicates: '重复',
    staged: '暂存中',
    failed: '失败',
    indexed: '已索引',
    indexRatio: '索引 %',
    size: '大小',
    minutes: '上传时间',
    firstSessionAt: '首次会话',
    lastSessionAt: '最近会话',
    lastActivityAt: '最后活动',
    mbPerSec: 'MB/秒',
    filesPerMin: '文件/分钟',
  },
  hint: {
    untracked:
      '这些文件没有记录复制结果。几乎都是重试的复制：首次尝试已将它们复制到 Drive，但在保存计数前中断，重试时跳过了它们。索引 % 可确认它们在 Drive 中。',
    failed: '复制失败的尝试次数。这些文件仍在暂存中或稍后已复制，因此不计入文件数。',
    indexRatio: '已索引照片 ÷ Drive 中的文件（已复制 + 未计数）。视频不会被索引。',
    size: '已复制到 Drive + 仍在暂存中。',
    minutes: '各会话时长之和（从首次联系到最后一次复制活动）。并行会话会重叠，因此可能超过实际时间。',
    attention: '卡住、出错、未完成或仍在复制的会话。',
  },
  total: '合计',
  unnamed: '（尚未命名）',
  expand: (l) => `展开 ${l}`,
  collapse: (l) => `折叠 ${l}`,
  showSessions: (l) => `显示 ${l} 的会话`,
  hideSessions: (l) => `隐藏 ${l} 的会话`,
  openDetails: (l) => `${l} 的明细`,
  statusLabel: { ok: '完成', in_progress: '复制中', stuck: '卡住', error: '错误', never_completed: '未完成' },
  stuckBadge: (n) => `${n} 个卡住`,
  errorBadge: (n) => `${n} 个错误`,
  neverBadge: (n) => `${n} 个未完成`,
  copyingBadge: (n) => `${n} 个复制中`,
  recoveredBadge: (n) => `${n} 个已恢复`,
  allEvent: '整个活动',
  session: '会话',
  close: '关闭',
  back: (l) => `返回 ${l}`,
  whereFiles: '文件去向',
  equation: (f, c, u, d, s) => `${f} 个文件 = ${c} 已复制 + ${u} 未计数 + ${d} 重复 + ${s} 暂存中`,
  legend: { copied: '已复制到 Drive', untracked: '未计数', dups: '跳过的重复', staged: '仍在暂存中' },
  untrackedNote: '未计数：由重试分块的首次尝试复制，该尝试在保存计数前中断。这些文件在 Drive 中。',
  failedNote: (n) => `${n} 次复制失败 — 这些文件仍在暂存中或稍后已复制。`,
  indexBlock: 'Find-Me 索引',
  indexedOf: (i, d) => `Drive 中 ${d} 个文件已索引 ${i} 个`,
  sizeBlock: '大小',
  copiedSize: '已复制到 Drive',
  stagedSize: '仍在暂存中',
  timeBlock: '时间',
  speedBlock: '速度',
  sessionsBlock: '会话',
  moreSessions: (n) => `显示全部 ${n} 个`,
  sessionId: '会话 ID',
  folders: 'Drive 文件夹',
  recoveredNote: '已由上传恢复重新派发。',
};

export const INSIGHTS_STRINGS = { en, zh };

/** What a row is called on screen: its value, a session's start time, or the whole event. */
export function nodeTitle(n: PivotNode, t: InsightsStrings): string {
  if (n.kind === 'total') return t.allEvent;
  if (n.session) return `${fmtShortTime(n.session.startedAt)} · ${n.session.batchId.slice(0, 8)}`;
  if (n.label) return n.label;
  return n.kind === 'uploader' ? t.unnamed : '—';
}
