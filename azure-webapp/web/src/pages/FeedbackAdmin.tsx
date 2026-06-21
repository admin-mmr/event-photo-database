import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { AdminFeedbackResponse, FeedbackItem, FeedbackVerdict } from '@cloud-webapp/shared';
import { apiGet, ApiError } from '../lib/api.js';

/** Compact local date-time for the feedback timestamp. */
function fmtWhen(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso || '—';
  return new Date(t).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function verdictBadge(v: FeedbackVerdict): { label: string; className: string } {
  return v === 'confirmed'
    ? { label: "That's me", className: 'badge badge-ok' }
    : { label: 'Wrong match', className: 'badge badge-err' };
}

type VerdictFilter = '' | FeedbackVerdict;

/**
 * Admin review queue (dev plan M4.4 / FR-16/FR-17). Renders the
 * `GET /api/admin/feedback` queue so admins can audit wrong/confirmed matches.
 * Server-authoritative: a non-admin caller gets a 403, which we surface as a
 * friendly empty state (mirrors the "Index now" pattern on Events).
 */
export function FeedbackAdmin(): JSX.Element {
  const [data, setData] = useState<AdminFeedbackResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [loading, setLoading] = useState(false);

  // Filters are applied server-side (query params) so the counts reflect them.
  const [eventId, setEventId] = useState('');
  const [verdict, setVerdict] = useState<VerdictFilter>('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setForbidden(false);
    const qs = new URLSearchParams();
    if (eventId.trim()) qs.set('eventId', eventId.trim());
    if (verdict) qs.set('verdict', verdict);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    try {
      const r = await apiGet<AdminFeedbackResponse>(`/api/admin/feedback${suffix}`);
      setData(r);
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) {
        setForbidden(true);
        setData(null);
      } else {
        setError(e instanceof Error ? e.message : 'Could not load feedback.');
      }
    } finally {
      setLoading(false);
    }
  }, [eventId, verdict]);

  useEffect(() => {
    void load();
  }, [load]);

  if (forbidden) {
    return (
      <div>
        <h2>Match feedback</h2>
        <p className="muted">
          This review queue is admin-only — sign in with an admin account to view it.
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="gallery-header">
        <h2>Match feedback</h2>
        {data && (
          <div className="event-meta">
            <span className="badge badge-ok">{data.counts.confirmed} confirmed</span>
            <span className="badge badge-err">{data.counts.not_me} wrong</span>
            <span className="muted event-stat">{data.total} in view</span>
          </div>
        )}
      </div>

      <div className="feedback-filters">
        <input
          className="feedback-input"
          type="text"
          placeholder="Filter by event ID"
          value={eventId}
          onChange={(e) => setEventId(e.target.value)}
        />
        <select
          className="feedback-input"
          value={verdict}
          onChange={(e) => setVerdict(e.target.value as VerdictFilter)}
          aria-label="Filter by verdict"
        >
          <option value="">All verdicts</option>
          <option value="not_me">Wrong match</option>
          <option value="confirmed">That&rsquo;s me</option>
        </select>
        <button className="btn btn-light btn-sm" onClick={() => void load()} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {error && <p className="error-text">{error}</p>}

      {data === null ? (
        <p className="muted">Loading feedback…</p>
      ) : data.items.length === 0 ? (
        <p className="muted">No feedback yet for this filter.</p>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Verdict</th>
                <th>Event</th>
                <th>Photo</th>
                <th>User</th>
                <th>Run</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((item: FeedbackItem) => {
                const badge = verdictBadge(item.verdict);
                return (
                  <tr key={item.feedbackId}>
                    <td className="muted">{fmtWhen(item.createdAt)}</td>
                    <td>
                      <span className={badge.className}>{badge.label}</span>
                    </td>
                    <td>
                      <Link to={`/events/${item.eventId}`} className="event-link">
                        {item.eventId}
                      </Link>
                    </td>
                    <td className="mono">{item.photoId}</td>
                    <td>{item.email ?? item.uid}</td>
                    <td className="mono muted">{item.runId ?? '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
