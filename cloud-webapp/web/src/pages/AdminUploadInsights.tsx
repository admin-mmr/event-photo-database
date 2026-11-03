import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import type {
  EventSummary,
  ListEventsResponse,
  UploadInsightsGroup,
  UploadInsightsResponse,
  UploadInsightsRow,
  UploadInsightsSession,
  UploadSessionStatus,
} from '@cloud-webapp/shared';
import { apiGet, ApiError } from '../lib/api.js';
import { eventLabel } from '../lib/eventLabel.js';
import { useStrings } from '../lib/i18n.js';
import { fmtBytes, fmtMinutes, fmtPct, fmtRate, fmtTime, sizeOf, sortRows, type SortKey } from '../lib/uploadInsights.js';

const STR = {
  en: {
    title: 'Upload insights',
    intro:
      'One row per club, tag and uploader. Upload time runs from the first time the server heard from a session to its last copy activity. Index % compares photos in the Find-Me index with files copied to Drive (videos are never indexed).',
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
    indexCountsAt: (when: string) => `Index counts as of ${when}.`,
    total: 'Total',
    club: 'Club',
    tag: 'Tag',
    uploader: 'Uploader',
    sessions: 'Sessions',
    files: 'Files',
    size: 'Size',
    minutes: 'Upload time',
    indexPct: 'Index %',
    first: 'First session',
    last: 'Last session',
    staged: 'In staging',
    duplicates: 'Duplicates',
    rate: 'MB/s',
    filesPerMin: 'Files/min',
    attention: 'Needs attention',
    showSessions: (who: string) => `Show sessions for ${who}`,
    session: 'Session',
    status: 'Status',
    folders: 'Drive folder',
    copied: 'Copied',
    untracked: 'Not counted',
    untrackedHint:
      'No copy result was recorded for these files. Almost always a retried copy: the first attempt copied them to Drive, then died before saving its counts, and the retry skipped them. Indexed / Index % confirms they are in Drive.',
    sumNote: 'Files = copied + not counted + duplicates + in staging. Failed counts failed copy attempts; those files stay in staging or were copied later.',
    failed: 'Failed',
    indexed: 'Indexed',
    started: 'Started',
    lastActivity: 'Last activity',
    statusLabel: {
      ok: 'done',
      in_progress: 'copying',
      stuck: 'stuck',
      error: 'error',
      never_completed: 'never completed',
    } satisfies Record<UploadSessionStatus, string>,
    stuckBadge: (n: number) => `${n} stuck`,
    errorBadge: (n: number) => `${n} error`,
    neverBadge: (n: number) => `${n} never completed`,
    copyingBadge: (n: number) => `${n} copying`,
    recoveredBadge: (n: number) => `${n} recovered`,
    unnamed: '(no name yet)',
  },
  zh: {
    title: '上传洞察',
    intro:
      '每个俱乐部、标签和上传者一行。上传时间从服务器首次收到该会话起，到最后一次复制活动为止。索引 % 为 Find-Me 索引中的照片数与已复制到 Drive 的文件数之比（视频不会被索引）。',
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
    indexCountsAt: (when: string) => `索引计数截至 ${when}。`,
    total: '合计',
    club: '俱乐部',
    tag: '标签',
    uploader: '上传者',
    sessions: '会话',
    files: '文件',
    size: '大小',
    minutes: '上传时间',
    indexPct: '索引 %',
    first: '首次会话',
    last: '最近会话',
    staged: '暂存中',
    duplicates: '重复',
    rate: 'MB/秒',
    filesPerMin: '文件/分钟',
    attention: '需要关注',
    showSessions: (who: string) => `显示 ${who} 的会话`,
    session: '会话',
    status: '状态',
    folders: 'Drive 文件夹',
    copied: '已复制',
    untracked: '未计数',
    untrackedHint:
      '这些文件没有记录复制结果。几乎都是重试的复制：首次尝试已将它们复制到 Drive，但在保存计数前中断，重试时跳过了它们。已索引 / 索引 % 可确认它们在 Drive 中。',
    sumNote: '文件 = 已复制 + 未计数 + 重复 + 暂存中。失败为复制失败的尝试次数；这些文件仍在暂存中或稍后已复制。',
    failed: '失败',
    indexed: '已索引',
    started: '开始',
    lastActivity: '最后活动',
    statusLabel: {
      ok: '完成',
      in_progress: '复制中',
      stuck: '卡住',
      error: '错误',
      never_completed: '未完成',
    } satisfies Record<UploadSessionStatus, string>,
    stuckBadge: (n: number) => `${n} 个卡住`,
    errorBadge: (n: number) => `${n} 个错误`,
    neverBadge: (n: number) => `${n} 个未完成`,
    copyingBadge: (n: number) => `${n} 个复制中`,
    recoveredBadge: (n: number) => `${n} 个已恢复`,
    unnamed: '（尚未命名）',
  },
};

function csvCell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

const STATUS_BADGE: Record<UploadSessionStatus, string> = {
  ok: 'badge badge-ok',
  in_progress: 'badge',
  stuck: 'badge badge-err',
  error: 'badge badge-err',
  never_completed: 'badge badge-warn',
};

/**
 * Per-uploader upload insights for one event: sessions, files, size, upload
 * time and index coverage per (club, tag, uploader), with the sessions behind
 * each row one click away so a stuck or never-completed upload can be found.
 * Club-scoped server-side (a club_admin only sees their own club).
 */
export function AdminUploadInsights(): JSX.Element {
  const t = useStrings(STR);
  const [events, setEvents] = useState<EventSummary[] | null>(null);
  const [eventId, setEventId] = useState('');
  const [data, setData] = useState<UploadInsightsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'lastSessionAt', dir: 'desc' });
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    apiGet<ListEventsResponse>('/api/events')
      .then((r) => setEvents([...r.events].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))))
      .catch((e) => {
        if (e instanceof ApiError && e.status === 403) setForbidden(true);
        setEvents([]);
      });
  }, []);

  const load = useCallback(
    async (id: string) => {
      setLoading(true);
      setError(null);
      try {
        setData(await apiGet<UploadInsightsResponse>(`/api/admin/upload-insights/${encodeURIComponent(id)}`));
      } catch (e) {
        setData(null);
        if (e instanceof ApiError && e.status === 403) setForbidden(true);
        else setError(e instanceof Error ? e.message : t.loadError);
      } finally {
        setLoading(false);
      }
    },
    [t.loadError],
  );

  const rows = useMemo(() => (data ? sortRows(data.groups, sort.key, sort.dir) : []), [data, sort]);

  function toggleSort(key: SortKey): void {
    setSort((s) =>
      s.key === key
        ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: key === 'clubName' || key === 'tag' || key === 'uploader' ? 'asc' : 'desc' },
    );
  }

  const groupKey = (g: UploadInsightsGroup): string => JSON.stringify([g.clubName, g.tag, g.uploader]);

  function downloadCsv(): void {
    if (!data) return;
    const head = [
      'club', 'tag', 'uploader', 'sessions', 'files', 'copied', 'notCounted', 'duplicates', 'failed', 'staged',
      'copiedBytes', 'stagedBytes', 'minutes', 'indexed', 'indexPct', 'mbPerSec', 'filesPerMin',
      'inProgress', 'stuck', 'errors', 'neverCompleted', 'recovered', 'firstSessionAt', 'lastSessionAt', 'lastActivityAt',
    ];
    const line = (r: UploadInsightsRow, label?: string): string =>
      [
        label ?? r.clubName, label ? '' : r.tag, label ? '' : r.uploader, r.sessions, r.files, r.copied, r.untracked,
        r.skippedDuplicates, r.failed, r.staged, r.copiedBytes ?? '', r.stagedBytes, r.minutes, r.indexed ?? '',
        r.indexRatio === null ? '' : Math.round(r.indexRatio * 100), r.mbPerSec?.toFixed(2) ?? '',
        r.filesPerMin?.toFixed(1) ?? '', r.inProgress, r.stuck, r.errors, r.neverCompleted, r.recovered,
        r.firstSessionAt, r.lastSessionAt, r.lastActivityAt,
      ]
        .map((x) => csvCell(String(x)))
        .join(',');
    const lines = [head.join(','), ...rows.map((r) => line(r)), line(data.totals, 'TOTAL')];
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    try {
      const a = document.createElement('a');
      a.href = url;
      a.download = `upload-insights-${data.eventId}-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    }
  }

  if (forbidden) {
    return (
      <div>
        <h2>{t.title}</h2>
        <p className="muted">{t.forbidden}</p>
      </div>
    );
  }

  const header = (key: SortKey, label: string, className?: string, hint?: string): JSX.Element => (
    <th
      className={className}
      title={hint}
      aria-sort={sort.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button type="button" className="btn-inline-link" onClick={() => toggleSort(key)}>
        {label}
        {sort.key === key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
      </button>
    </th>
  );

  const badges = (r: UploadInsightsRow): JSX.Element => (
    <>
      {r.stuck > 0 && <span className="badge badge-err">{t.stuckBadge(r.stuck)}</span>}{' '}
      {r.errors > 0 && <span className="badge badge-err">{t.errorBadge(r.errors)}</span>}{' '}
      {r.neverCompleted > 0 && <span className="badge badge-warn">{t.neverBadge(r.neverCompleted)}</span>}{' '}
      {r.inProgress > 0 && <span className="badge">{t.copyingBadge(r.inProgress)}</span>}{' '}
      {r.recovered > 0 && <span className="muted">{t.recoveredBadge(r.recovered)}</span>}
    </>
  );

  const cells = (r: UploadInsightsRow): JSX.Element => (
    <>
      <td data-label={t.attention}>{badges(r)}</td>
      <td data-label={t.sessions}>{r.sessions}</td>
      <td data-label={t.files}>{r.files}</td>
      <td data-label={t.copied}>{r.copied}</td>
      <td data-label={t.untracked} title={r.untracked > 0 ? t.untrackedHint : undefined}>{r.untracked}</td>
      <td data-label={t.duplicates}>{r.skippedDuplicates}</td>
      <td data-label={t.staged}>{r.staged > 0 ? `${r.staged} (${fmtBytes(r.stagedBytes)})` : 0}</td>
      <td data-label={t.indexPct}>{fmtPct(r.indexRatio)}</td>
      <td data-label={t.size}>{fmtBytes(sizeOf(r))}</td>
      <td data-label={t.minutes}>{fmtMinutes(r.minutes)}</td>
      <td data-label={t.first}>{fmtTime(r.firstSessionAt)}</td>
      <td data-label={t.last}>{fmtTime(r.lastSessionAt)}</td>
      <td data-label={t.rate}>{fmtRate(r.mbPerSec, 2)}</td>
      <td data-label={t.filesPerMin}>{fmtRate(r.filesPerMin, 1)}</td>
    </>
  );

  const sessionRow = (s: UploadInsightsSession): JSX.Element => (
    <tr key={s.batchId}>
      <td className="mono" data-label={t.session} title={s.batchId}>{s.batchId.slice(0, 8)}</td>
      <td data-label={t.status}>
        <span className={STATUS_BADGE[s.status]}>{t.statusLabel[s.status]}</span>
      </td>
      <td data-label={t.files}>{s.files}</td>
      <td data-label={t.copied}>{s.copied}</td>
      <td data-label={t.untracked} title={s.untracked > 0 ? t.untrackedHint : undefined}>{s.untracked}</td>
      <td data-label={t.duplicates}>{s.skippedDuplicates}</td>
      <td data-label={t.staged}>{s.staged}</td>
      <td data-label={t.failed}>{s.failed}</td>
      <td data-label={t.indexed}>{s.indexed ?? '—'}</td>
      <td data-label={t.size}>{fmtBytes(s.copiedBytes === null ? null : s.copiedBytes + s.stagedBytes)}</td>
      <td data-label={t.started}>{fmtTime(s.startedAt)}</td>
      <td data-label={t.lastActivity}>{fmtTime(s.lastActivityAt)}</td>
      <td data-label={t.minutes}>{fmtMinutes(s.minutes)}</td>
      <td className="mono" data-label={t.folders}>{s.batchFolders.join(', ') || '—'}</td>
    </tr>
  );

  return (
    <div className="insights-page">
      <div className="gallery-header">
        <h2>{t.title}</h2>
        <button className="btn btn-light btn-sm" onClick={downloadCsv} disabled={!data || data.groups.length === 0}>
          {t.exportCsv}
        </button>
      </div>
      <p className="muted">{t.intro}</p>

      <div className="feedback-filters">
        <label>
          {t.eventLabel}{' '}
          <select
            className="feedback-input"
            value={eventId}
            disabled={events === null || loading}
            onChange={(e) => {
              const id = e.target.value;
              setEventId(id);
              setData(null);
              setOpen(new Set());
              if (id) void load(id);
            }}
          >
            <option value="">{events === null ? t.loadingEvents : t.choose}</option>
            {(events ?? []).map((ev) => (
              <option key={ev.id} value={ev.id}>
                {eventLabel({ name: ev.name, date: ev.date, id: ev.id })}
              </option>
            ))}
          </select>
        </label>
        <button className="btn btn-light btn-sm" disabled={!eventId || loading} onClick={() => void load(eventId)}>
          {loading ? t.loading : t.refresh}
        </button>
      </div>

      {error && <p className="error-text">{error}</p>}
      {data?.warnings.map((w) => (
        <p key={w} className="muted">
          {w}
        </p>
      ))}

      {data && (
        <>
          <p className="muted">
            {data.indexCountsAt ? t.indexCountsAt(fmtTime(data.indexCountsAt)) : t.noIndexCounts}
          </p>
          {data.groups.length === 0 ? (
            <p className="muted">{t.noUploads}</p>
          ) : (
            <div className="table-wrap insights-table-wrap">
              <table className="data-table insights-table">
                <thead>
                  <tr>
                    {header('clubName', t.club, 'sticky-c1')}
                    {header('tag', t.tag, 'sticky-c2')}
                    {header('uploader', t.uploader, 'sticky-c3')}
                    {header('attention', t.attention)}
                    {header('sessions', t.sessions)}
                    {header('files', t.files)}
                    {header('copied', t.copied)}
                    {header('untracked', t.untracked, undefined, t.untrackedHint)}
                    {header('skippedDuplicates', t.duplicates)}
                    {header('staged', t.staged)}
                    {header('indexRatio', t.indexPct)}
                    {header('size', t.size)}
                    {header('minutes', t.minutes)}
                    {header('firstSessionAt', t.first)}
                    {header('lastSessionAt', t.last)}
                    {header('mbPerSec', t.rate)}
                    {header('filesPerMin', t.filesPerMin)}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((g) => {
                    const key = groupKey(g);
                    const isOpen = open.has(key);
                    const who = g.uploader || t.unnamed;
                    return (
                      <Fragment key={key}>
                        <tr>
                          <td className="mono sticky-c1" data-label={t.club} title={g.clubName}>{g.clubName || '—'}</td>
                          <td className="sticky-c2" data-label={t.tag} title={g.tag}>{g.tag || '—'}</td>
                          <td className="sticky-c3" data-label={t.uploader}>
                            <button
                              type="button"
                              className="btn-inline-link"
                              aria-expanded={isOpen}
                              aria-label={t.showSessions(who)}
                              onClick={() =>
                                setOpen((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(key)) next.delete(key);
                                  else next.add(key);
                                  return next;
                                })
                              }
                            >
                              {isOpen ? '▾ ' : '▸ '}
                              {who}
                            </button>
                          </td>
                          {cells(g)}
                        </tr>
                        {isOpen && (
                          <tr>
                            <td colSpan={17} className="insights-sessions-cell">
                              <div className="insights-sessions">
                              <p className="muted insights-sum-note">{t.sumNote}</p>
                              <table className="data-table">
                                <thead>
                                  <tr>
                                    <th>{t.session}</th>
                                    <th>{t.status}</th>
                                    <th>{t.files}</th>
                                    <th>{t.copied}</th>
                                    <th title={t.untrackedHint}>{t.untracked}</th>
                                    <th>{t.duplicates}</th>
                                    <th>{t.staged}</th>
                                    <th>{t.failed}</th>
                                    <th>{t.indexed}</th>
                                    <th>{t.size}</th>
                                    <th>{t.started}</th>
                                    <th>{t.lastActivity}</th>
                                    <th>{t.minutes}</th>
                                    <th>{t.folders}</th>
                                  </tr>
                                </thead>
                                <tbody>{g.sessionList.map(sessionRow)}</tbody>
                              </table>
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                  {/* A body row, not <tfoot>: on phones each body row becomes a card. */}
                  <tr className="totals-row">
                    <td className="sticky-c1" data-label={t.club}>
                      <strong>{t.total}</strong>
                    </td>
                    <td className="sticky-c2" data-label={t.tag}>—</td>
                    <td className="sticky-c3" data-label={t.uploader}>—</td>
                    {cells(data.totals)}
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
