import { useEffect, useRef, useState } from 'react';
import type { UploadInsightsRow, UploadSessionStatus } from '@cloud-webapp/shared';
import {
  ALL_DIMS,
  fmtBytes,
  fmtCount,
  fmtMinutes,
  fmtPct,
  fmtRate,
  fmtShortTime,
  fmtTime,
  sessionNodes,
  sizeOf,
  type PivotNode,
} from '../lib/uploadInsights.js';
import { nodeTitle, type InsightsStrings } from '../lib/uploadInsightsStrings.js';

const STATUS_BADGE: Record<UploadSessionStatus, string> = {
  ok: 'badge badge-ok',
  in_progress: 'badge',
  stuck: 'badge badge-err',
  error: 'badge badge-err',
  never_completed: 'badge badge-warn',
};

export function StatusBadge(props: { t: InsightsStrings; status: UploadSessionStatus }): JSX.Element {
  return <span className={STATUS_BADGE[props.status]}>{props.t.statusLabel[props.status]}</span>;
}

/** The problem counts of a roll-up, worst first; nothing when all is well. */
export function AttentionBadges(props: { t: InsightsStrings; row: UploadInsightsRow }): JSX.Element {
  const { t, row: r } = props;
  return (
    <span className="insights-badges">
      {r.stuck > 0 && <span className="badge badge-err">{t.stuckBadge(r.stuck)}</span>}
      {r.errors > 0 && <span className="badge badge-err">{t.errorBadge(r.errors)}</span>}
      {r.neverCompleted > 0 && <span className="badge badge-warn">{t.neverBadge(r.neverCompleted)}</span>}
      {r.inProgress > 0 && <span className="badge">{t.copyingBadge(r.inProgress)}</span>}
      {r.recovered > 0 && <span className="muted">{t.recoveredBadge(r.recovered)}</span>}
    </span>
  );
}

const MAX_LISTED_SESSIONS = 25;

/**
 * Everything about one row as a readable block: where its files went (the
 * parts that make up Files, as a bar and as the sum), index coverage, size,
 * time and speed, and the sessions behind it — each of which opens here too.
 * A side panel rather than a hover tooltip: it works on a phone, stays put
 * while the table scrolls, and its numbers can be selected and copied.
 */
export function UploadInsightsDetail(props: {
  t: InsightsStrings;
  stack: ReadonlyArray<PivotNode>;
  onOpen: (node: PivotNode) => void;
  onBack: () => void;
  onClose: () => void;
}): JSX.Element | null {
  const { t, stack, onOpen, onBack, onClose } = props;
  const node = stack[stack.length - 1];
  const prev = stack.length > 1 ? stack[stack.length - 2] : undefined;
  const heading = useRef<HTMLHeadingElement>(null);
  const [allSessions, setAllSessions] = useState(false);

  useEffect(() => {
    heading.current?.focus();
    setAllSessions(false);
  }, [node]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!node) return null;
  const m = node.metrics;
  const title = nodeTitle(node, t);
  const kind = node.kind === 'total' ? '' : node.kind === 'session' ? t.session : t.dim[node.kind];
  // The row's place in the hierarchy, minus the row itself.
  const crumbs = ALL_DIMS.filter((d) => node.path[d] !== undefined && d !== node.kind).map(
    (d) => `${t.dim[d]}: ${node.path[d] || (d === 'uploader' ? t.unnamed : '—')}`,
  );

  const parts = [
    { id: 'copied', label: t.legend.copied, n: m.copied },
    { id: 'untracked', label: t.legend.untracked, n: m.untracked },
    { id: 'dups', label: t.legend.dups, n: m.skippedDuplicates },
    { id: 'staged', label: t.legend.staged, n: m.staged },
  ] as const;
  const equation = t.equation(
    fmtCount(m.files),
    fmtCount(m.copied),
    fmtCount(m.untracked),
    fmtCount(m.skippedDuplicates),
    fmtCount(m.staged),
  );
  const sessions =
    node.session === undefined
      ? sessionNodes(node).sort((a, b) => (b.session?.startedAt ?? '').localeCompare(a.session?.startedAt ?? ''))
      : [];

  return (
    <aside className="insights-detail" aria-labelledby="insights-detail-title">
      <div className="insights-detail-head">
        <div className="insights-detail-nav">
          {prev ? (
            <button type="button" className="btn-inline-link" onClick={onBack}>
              ← {t.back(nodeTitle(prev, t))}
            </button>
          ) : (
            <span />
          )}
          <button type="button" className="insights-detail-close" aria-label={t.close} onClick={onClose}>
            ×
          </button>
        </div>
        {kind && <p className="insights-detail-kicker">{kind}</p>}
        <h3 id="insights-detail-title" ref={heading} tabIndex={-1}>
          {title}
        </h3>
        {crumbs.length > 0 && <p className="muted insights-detail-crumbs">{crumbs.join(' · ')}</p>}
        {node.session && <StatusBadge t={t} status={node.session.status} />}
        {!node.session && <AttentionBadges t={t} row={m} />}
      </div>

      <section className="insights-detail-section">
        <h4>{t.whereFiles}</h4>
        {m.files > 0 && (
          <div className="insights-bar" role="img" aria-label={equation}>
            {parts.map((p) =>
              p.n > 0 ? (
                <span key={p.id} className={`insights-bar-${p.id}`} style={{ width: `${(p.n / m.files) * 100}%` }} />
              ) : null,
            )}
          </div>
        )}
        <ul className="insights-legend">
          {parts.map((p) => (
            <li key={p.id}>
              <span className={`insights-swatch insights-bar-${p.id}`} aria-hidden="true" />
              <span>{p.label}</span>
              <strong>{fmtCount(p.n)}</strong>
              <span className="muted">{m.files > 0 ? fmtPct(p.n / m.files) : ''}</span>
            </li>
          ))}
        </ul>
        <p className="insights-equation">{equation}</p>
        {m.untracked > 0 && <p className="muted insights-note">{t.untrackedNote}</p>}
        {m.failed > 0 && <p className="muted insights-note">{t.failedNote(fmtCount(m.failed))}</p>}
      </section>

      <section className="insights-detail-section">
        <h4>{t.indexBlock}</h4>
        <p className="insights-big">{fmtPct(m.indexRatio)}</p>
        <p className="muted insights-note">
          {m.indexed === null ? t.noIndexCounts : t.indexedOf(fmtCount(m.indexed), fmtCount(m.copied + m.untracked))}
        </p>
      </section>

      <section className="insights-detail-section">
        <h4>{t.sizeBlock}</h4>
        <dl className="insights-facts">
          <dt>{t.copiedSize}</dt>
          <dd>{fmtBytes(m.copiedBytes)}</dd>
          <dt>{t.stagedSize}</dt>
          <dd>{fmtBytes(m.stagedBytes)}</dd>
          {(m.stagedInGallery ?? 0) > 0 && (
            <>
              <dt>{t.stagedLeftoverSize}</dt>
              <dd>
                {t.stagedLeftoverFact(fmtCount(m.stagedInGallery ?? 0), fmtBytes(m.stagedInGalleryBytes ?? 0))}
              </dd>
            </>
          )}
          <dt>{t.col.size}</dt>
          <dd>{fmtBytes(sizeOf(m))}</dd>
        </dl>
      </section>

      <section className="insights-detail-section">
        <h4>{t.timeBlock}</h4>
        <dl className="insights-facts">
          {node.session ? (
            <>
              <dt>{t.col.firstSessionAt}</dt>
              <dd>{fmtTime(node.session.startedAt)}</dd>
            </>
          ) : (
            <>
              <dt>{t.col.firstSessionAt}</dt>
              <dd>{fmtTime(m.firstSessionAt)}</dd>
              <dt>{t.col.lastSessionAt}</dt>
              <dd>{fmtTime(m.lastSessionAt)}</dd>
            </>
          )}
          <dt>{t.col.lastActivityAt}</dt>
          <dd>{fmtTime(m.lastActivityAt)}</dd>
          <dt title={t.hint.minutes}>{t.col.minutes}</dt>
          <dd>{fmtMinutes(m.minutes)}</dd>
        </dl>
      </section>

      <section className="insights-detail-section">
        <h4>{t.speedBlock}</h4>
        <dl className="insights-facts">
          <dt>{t.col.mbPerSec}</dt>
          <dd>{fmtRate(m.mbPerSec, 2)}</dd>
          <dt>{t.col.filesPerMin}</dt>
          <dd>{fmtRate(m.filesPerMin, 1)}</dd>
        </dl>
      </section>

      {node.session ? (
        <section className="insights-detail-section">
          <dl className="insights-facts insights-facts-stacked">
            <dt>{t.sessionId}</dt>
            <dd className="mono">{node.session.batchId}</dd>
            <dt>{t.folders}</dt>
            <dd className="mono">{node.session.batchFolders.join(', ') || '—'}</dd>
          </dl>
          {node.session.recovered && <p className="muted insights-note">{t.recoveredNote}</p>}
        </section>
      ) : (
        <section className="insights-detail-section">
          <h4>
            {t.sessionsBlock} · {fmtCount(m.sessions)}
          </h4>
          <ul className="insights-session-list">
            {(allSessions ? sessions : sessions.slice(0, MAX_LISTED_SESSIONS)).map((s) => (
              <li key={s.key}>
                <button type="button" onClick={() => onOpen(s)}>
                  {s.session && <StatusBadge t={t} status={s.session.status} />}
                  <span>{fmtShortTime(s.session?.startedAt ?? '')}</span>
                  <span className="muted">
                    {fmtCount(s.metrics.files)} {t.col.files.toLowerCase()}
                  </span>
                  {node.path.uploader === undefined && (
                    <span className="muted insights-session-who">{s.path.uploader || t.unnamed}</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
          {!allSessions && sessions.length > MAX_LISTED_SESSIONS && (
            <button type="button" className="btn btn-light btn-sm" onClick={() => setAllSessions(true)}>
              {t.moreSessions(sessions.length)}
            </button>
          )}
        </section>
      )}
    </aside>
  );
}
