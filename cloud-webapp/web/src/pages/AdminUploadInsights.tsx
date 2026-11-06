import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import type { EventSummary, ListEventsResponse, UploadInsightsResponse } from '@cloud-webapp/shared';
import { apiGet, ApiError } from '../lib/api.js';
import { eventLabel } from '../lib/eventLabel.js';
import { useStrings } from '../lib/i18n.js';
import {
  ALL_DIMS,
  allGroupKeys,
  buildPivot,
  defaultLayout,
  fmtBytes,
  fmtCount,
  fmtMinutes,
  fmtPct,
  fmtRate,
  fmtTime,
  readLayout,
  saveLayout,
  sizeOf,
  sortNodes,
  visibleRows,
  type ColumnId,
  type Dim,
  type InsightsLayout,
  type PivotNode,
  type SortKey,
  unresolvedFailedOf,
  waitingOf,
} from '../lib/uploadInsights.js';
import { INSIGHTS_STRINGS, nodeTitle, type InsightsStrings } from '../lib/uploadInsightsStrings.js';
import { InsightsColumnPicker } from '../components/InsightsColumnPicker.js';
import { AttentionBadges, StatusBadge, UploadInsightsDetail } from '../components/UploadInsightsDetail.js';

/** Frozen label column widths (px); a column's left edge is the sum of those before it. */
const DIM_WIDTH: Record<Dim, number> = { club: 170, tag: 130, uploader: 190 };

/** Text sorts A→Z first; numbers and times biggest/latest first. */
const firstDir = (key: SortKey): 'asc' | 'desc' => (key === 'label' ? 'asc' : 'desc');

function csvCell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function cell(c: ColumnId, n: PivotNode, t: InsightsStrings): JSX.Element | string {
  const m = n.metrics;
  switch (c) {
    case 'attention':
      return n.session ? <StatusBadge t={t} status={n.session.status} /> : <AttentionBadges t={t} row={m} />;
    case 'staged': {
      // Only what is still waiting is a warning; leftovers already in the
      // gallery are shown muted beside it (see waitingOf).
      const waiting = waitingOf(m);
      const leftover = m.stagedInGallery ?? 0;
      if (m.staged === 0) return '0';
      return (
        <span>
          {waiting > 0 ? (
            <span className="insights-warn">
              {fmtCount(waiting)} <span className="muted">({fmtBytes(m.stagedBytes - (m.stagedInGalleryBytes ?? 0))})</span>
            </span>
          ) : (
            '0'
          )}
          {leftover > 0 && <span className="muted"> {t.stagedLeftover(fmtCount(leftover))}</span>}
        </span>
      );
    }
    case 'failed': {
      // Only failures whose file is still waiting are a problem; the rest were
      // re-copied and are shown muted (see unresolvedFailedOf).
      if (m.failed === 0) return '0';
      const open = unresolvedFailedOf(m);
      const recovered = m.failed - open;
      return (
        <span>
          {open > 0 ? <span className="insights-warn">{fmtCount(open)}</span> : '0'}
          {recovered > 0 && <span className="muted"> {t.failedRecovered(fmtCount(recovered))}</span>}
        </span>
      );
    }
    case 'indexed':
      return m.indexed === null ? '—' : fmtCount(m.indexed);
    case 'indexRatio':
      return fmtPct(m.indexRatio);
    case 'size':
      return fmtBytes(sizeOf(m));
    case 'minutes':
      return fmtMinutes(m.minutes);
    case 'firstSessionAt':
      return fmtTime(m.firstSessionAt);
    case 'lastSessionAt':
      return fmtTime(m.lastSessionAt);
    case 'lastActivityAt':
      return fmtTime(m.lastActivityAt);
    case 'mbPerSec':
      return fmtRate(m.mbPerSec, 2);
    case 'filesPerMin':
      return fmtRate(m.filesPerMin, 1);
    default:
      return fmtCount(m[c]);
  }
}

const NUMERIC: ReadonlySet<ColumnId> = new Set<ColumnId>([
  'sessions', 'files', 'copied', 'untracked', 'skippedDuplicates', 'staged', 'failed', 'indexed', 'indexRatio',
  'size', 'minutes', 'mbPerSec', 'filesPerMin',
]);

/**
 * Upload insights for one event as a pivot: rows grouped by any order of club /
 * tag / uploader, each level rolled up from the sessions beneath it, the last
 * level opening onto its sessions. The header row and the grouping columns stay
 * put while the table scrolls; columns are pickable; a row opens a detail panel
 * with its whole breakdown. Club-scoped server-side (a club_admin only sees
 * their own club).
 */
export function AdminUploadInsights(): JSX.Element {
  const t = useStrings(INSIGHTS_STRINGS);
  const [events, setEvents] = useState<EventSummary[] | null>(null);
  const [eventId, setEventId] = useState('');
  const [data, setData] = useState<UploadInsightsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [layout, setLayoutState] = useState<InsightsLayout>(readLayout);
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'lastSessionAt', dir: 'desc' });
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [sessionsOpen, setSessionsOpen] = useState<ReadonlySet<string>>(new Set());
  const [detail, setDetail] = useState<PivotNode[]>([]);
  const tableBox = useRef<HTMLDivElement>(null);

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
      setDetail([]);
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

  function setLayout(next: InsightsLayout): void {
    // Regrouping changes every row key, so open/closed state and the panel reset.
    if (next.dims.join() !== layout.dims.join()) {
      setCollapsed(new Set());
      setSessionsOpen(new Set());
      setDetail([]);
    }
    setLayoutState(next);
    saveLayout(next);
  }

  const pivot = useMemo(() => (data ? buildPivot(data.groups, layout.dims) : null), [data, layout.dims]);
  const rows = useMemo(
    () => (pivot ? visibleRows(pivot.children, { collapsed, sessionsOpen, key: sort.key, dir: sort.dir }) : []),
    [pivot, collapsed, sessionsOpen, sort],
  );
  const columns = layout.columns;
  const dims = layout.dims;
  const panelOpen = detail.length > 0;

  // The table box ends at the bottom of the window, so both of its scrollbars
  // are on screen without scrolling the page first. Measured from the top of
  // the document, so it fits the window as first seen, whatever sits above it.
  useLayoutEffect(() => {
    const box = tableBox.current;
    if (!box) return;
    const fit = (): void => {
      const top = box.getBoundingClientRect().top + window.scrollY;
      box.style.setProperty('--fit-height', `${Math.max(320, Math.round(window.innerHeight - top - 16))}px`);
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [pivot, layout, panelOpen]);
  const inDetail = new Set(detail.map((n) => n.key));
  const closeDetail = useCallback(() => setDetail([]), []);

  function toggleSort(key: SortKey): void {
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: firstDir(key) }));
  }

  const toggleIn = (set: ReadonlySet<string>, key: string): Set<string> => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  };

  function downloadCsv(): void {
    if (!data || !pivot) return;
    // One line per row of the finest grouping, whatever is collapsed on screen.
    const leaves: PivotNode[] = [];
    const walk = (level: PivotNode[]): void => {
      for (const n of sortNodes(level, sort.key, sort.dir)) {
        if (n.children.length > 0) walk(n.children);
        else leaves.push(n);
      }
    };
    walk(pivot.children);
    const metrics = [
      'sessions', 'files', 'copied', 'untracked', 'skippedDuplicates', 'staged', 'stagedInGallery', 'failed', 'failedUnresolved',
      'copiedBytes', 'stagedBytes', 'stagedInGalleryBytes',
      'minutes', 'indexed', 'indexRatio', 'mbPerSec', 'filesPerMin', 'inProgress', 'stuck', 'errors', 'neverCompleted',
      'recovered', 'firstSessionAt', 'lastSessionAt', 'lastActivityAt',
    ] as const;
    const line = (n: PivotNode, label?: string): string =>
      [
        ...dims.map((d, i) => (label ? (i === 0 ? label : '') : (n.path[d] ?? ''))),
        ...metrics.map((k) => {
          const v = n.metrics[k];
          if (v === null || v === undefined) return '';
          if (k === 'indexRatio') return Math.round((v as number) * 100);
          if (k === 'mbPerSec') return (v as number).toFixed(2);
          if (k === 'filesPerMin') return (v as number).toFixed(1);
          return v;
        }),
      ]
        .map((x) => csvCell(String(x)))
        .join(',');
    const head = [...dims, ...metrics.map((k) => (k === 'indexRatio' ? 'indexPct' : k))];
    const lines = [head.join(','), ...leaves.map((n) => line(n)), line(pivot, 'TOTAL')];
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    try {
      const a = document.createElement('a');
      a.href = url;
      a.download = `upload-insights-${data.eventId}-${dims.join('-')}-${new Date().toISOString().slice(0, 10)}.csv`;
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

  /** Each grouping column's frozen width and left edge, as CSS variables the desktop rules read. */
  const dimStyle = (i: number): CSSProperties =>
    ({
      '--pivot-left': `${dims.slice(0, i).reduce((a, d) => a + DIM_WIDTH[d], 0)}px`,
      '--pivot-w': `${DIM_WIDTH[dims[i] as Dim]}px`,
    }) as CSSProperties;
  const dimClass = (i: number, extra = ''): string =>
    `pivot-dim${i === dims.length - 1 ? ' pivot-dim-last' : ''}${extra ? ` ${extra}` : ''}`;

  const sortHeader = (
    key: SortKey,
    label: string,
    opts: { className?: string | undefined; style?: CSSProperties; hint?: string | undefined } = {},
  ): JSX.Element => (
    <th
      key={`${key}-${label}`}
      className={opts.className}
      style={opts.style}
      title={opts.hint}
      aria-sort={sort.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button type="button" className="pivot-sort" onClick={() => toggleSort(key)}>
        {label}
        {sort.key === key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
      </button>
    </th>
  );

  function labelCell(n: PivotNode, i: number): JSX.Element {
    const title = nodeTitle(n, t);
    const isGroup = n.children.length > 0;
    const open = isGroup ? !collapsed.has(n.key) : sessionsOpen.has(n.key);
    const crumbs = ALL_DIMS.filter((d) => n.path[d] !== undefined).map((d) => n.path[d] || '—').join(' › ');
    return (
      <td key={`dim-${i}`} className={dimClass(i, 'pivot-label')} style={dimStyle(i)} data-label={n.session ? t.session : t.dim[n.kind as Dim]}>
        <span className="pivot-label-inner" title={n.session ? `${crumbs} › ${n.session.batchId}` : crumbs}>
          {n.session ? (
            <span className="pivot-session-mark" aria-hidden="true">
              ↳
            </span>
          ) : (
            <button
              type="button"
              className="pivot-toggle"
              aria-expanded={open}
              aria-label={
                isGroup ? (open ? t.collapse(title) : t.expand(title)) : open ? t.hideSessions(title) : t.showSessions(title)
              }
              onClick={(e) => {
                e.stopPropagation();
                if (isGroup) setCollapsed((s) => toggleIn(s, n.key));
                else setSessionsOpen((s) => toggleIn(s, n.key));
              }}
            >
              {open ? '▾' : '▸'}
            </button>
          )}
          <span className={n.session ? 'pivot-text pivot-session-text' : 'pivot-text'}>{title}</span>
        </span>
      </td>
    );
  }

  function row(n: PivotNode): JSX.Element {
    // A session sits in the last grouping column, under the row it belongs to.
    const labelAt = n.kind === 'session' || n.kind === 'total' ? (n.kind === 'total' ? 0 : dims.length - 1) : n.depth;
    const level = n.kind === 'session' ? 'pivot-session' : n.kind === 'total' ? 'pivot-total' : `pivot-l${n.depth}${n.children.length > 0 ? ' pivot-group' : ''}`;
    const open = (): void => setDetail([n]);
    return (
      <tr
        key={n.key}
        className={`pivot-row ${level}${inDetail.has(n.key) ? ' is-selected' : ''}`}
        tabIndex={0}
        aria-label={t.openDetails(nodeTitle(n, t))}
        onClick={open}
        onKeyDown={(e: KeyboardEvent<HTMLTableRowElement>) => {
          if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            open();
          }
        }}
      >
        {dims.map((_, i) =>
          i !== labelAt ? (
            <td key={`dim-${i}`} className={dimClass(i, 'pivot-dim-empty')} style={dimStyle(i)} />
          ) : n.kind === 'total' ? (
            <td key={`dim-${i}`} className={dimClass(i, 'pivot-label')} style={dimStyle(i)} data-label={t.total}>
              <span className="pivot-label-inner">
                <span className="pivot-text">{t.total}</span>
              </span>
            </td>
          ) : (
            labelCell(n, i)
          ),
        )}
        {columns.map((c) => (
          <td
            key={c}
            className={NUMERIC.has(c) ? 'num' : undefined}
            data-label={t.col[c]}
            title={c === 'untracked' && n.metrics.untracked > 0 ? t.hint.untracked : undefined}
          >
            {cell(c, n, t)}
          </td>
        ))}
      </tr>
    );
  }

  const missing = ALL_DIMS.filter((d) => !dims.includes(d));

  return (
    <div className={`insights-page${panelOpen ? ' has-detail' : ''}`}>
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
              setCollapsed(new Set());
              setSessionsOpen(new Set());
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

      {data && pivot && (
        <>
          {data.groups.length === 0 ? (
            <p className="muted">{t.noUploads}</p>
          ) : (
            <>
              <div className="insights-toolbar">
                <div className="insights-dims" role="group" aria-label={t.rows}>
                  <span className="insights-toolbar-label">{t.rows}</span>
                  {dims.map((d, i) => (
                    <span key={d} className="insights-dim-chip">
                      {i > 0 && (
                        <button
                          type="button"
                          aria-label={t.moveEarlier(t.dim[d])}
                          onClick={() => {
                            const next = [...dims];
                            next.splice(i - 1, 2, d, dims[i - 1] as Dim);
                            setLayout({ ...layout, dims: next });
                          }}
                        >
                          ←
                        </button>
                      )}
                      <span className="insights-dim-name">{t.dim[d]}</span>
                      {dims.length > 1 && (
                        <button
                          type="button"
                          aria-label={t.removeDim(t.dim[d])}
                          onClick={() => setLayout({ ...layout, dims: dims.filter((x) => x !== d) })}
                        >
                          ×
                        </button>
                      )}
                    </span>
                  ))}
                  {missing.map((d) => (
                    <button
                      key={d}
                      type="button"
                      className="insights-dim-add"
                      aria-label={t.addDim(t.dim[d])}
                      onClick={() => setLayout({ ...layout, dims: [...dims, d] })}
                    >
                      + {t.dim[d]}
                    </button>
                  ))}
                </div>
                <div className="insights-toolbar-actions">
                  {dims.length > 1 && (
                    <>
                      <button type="button" className="btn btn-light btn-sm" onClick={() => setCollapsed(new Set())}>
                        {t.expandAll}
                      </button>
                      <button
                        type="button"
                        className="btn btn-light btn-sm"
                        onClick={() => {
                          setCollapsed(new Set(allGroupKeys(pivot.children)));
                          setSessionsOpen(new Set());
                        }}
                      >
                        {t.collapseAll}
                      </button>
                    </>
                  )}
                  <InsightsColumnPicker
                    t={t}
                    selected={columns}
                    onChange={(next) => setLayout({ ...layout, columns: next })}
                    onReset={() => setLayout(defaultLayout())}
                  />
                </div>
              </div>

              <div className="table-wrap insights-table-wrap" ref={tableBox}>
                <table className="data-table insights-table">
                  <thead>
                    <tr>
                      {dims.map((d, i) => sortHeader('label', t.dim[d], { className: dimClass(i), style: dimStyle(i) }))}
                      {columns.map((c) =>
                        sortHeader(c, t.col[c], { className: NUMERIC.has(c) ? 'num' : undefined, hint: t.hint[c] }),
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(row)}
                    {row(pivot)}
                  </tbody>
                </table>
              </div>
              <p className="muted insights-note">
                {data.indexCountsAt ? t.indexCountsAt(fmtTime(data.indexCountsAt)) : t.noIndexCounts}
              </p>
            </>
          )}
        </>
      )}

      {panelOpen && (
        <UploadInsightsDetail
          t={t}
          stack={detail}
          onOpen={(n) => setDetail((s) => [...s, n])}
          onBack={() => setDetail((s) => s.slice(0, -1))}
          onClose={closeDetail}
        />
      )}
    </div>
  );
}
