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
    ? { label: "That's me · 是我", className: 'badge badge-ok' }
    : { label: 'Wrong match · 匹配错误', className: 'badge badge-err' };
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
        setError(e instanceof Error ? e.message : 'Could not load feedback. · 无法加载反馈。');
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
        <h2>Match feedback · 匹配反馈</h2>
        <p className="muted">
          This review queue is admin-only — sign in with an admin account to view it. ·
          此审核队列仅限管理员，请使用管理员账号登录查看。
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="gallery-header">
        <h2>Match feedback · 匹配反馈</h2>
        {data && (
          <div className="event-meta">
            <span className="badge badge-ok">{data.counts.confirmed} confirmed · {data.counts.confirmed} 已确认</span>
            <span className="badge badge-err">{data.counts.not_me} wrong · {data.counts.not_me} 错误</span>
            <span className="muted event-stat">{data.total} in view · 共 {data.total} 条</span>
          </div>
        )}
      </div>

      <div className="feedback-filters">
        <input
          className="feedback-input"
          type="text"
          placeholder="Filter by event ID · 按活动 ID 筛选"
          value={eventId}
          onChange={(e) => setEventId(e.target.value)}
        />
        <select
          className="feedback-input"
          value={verdict}
          onChange={(e) => setVerdict(e.target.value as VerdictFilter)}
          aria-label="Filter by verdict · 按结论筛选"
        >
          <option value="">All verdicts · 全部结论</option>
          <option value="not_me">Wrong match · 匹配错误</option>
          <option value="confirmed">That&rsquo;s me · 是我</option>
        </select>
        <button className="btn btn-light btn-sm" onClick={() => void load()} disabled={loading}>
          {loading ? 'Refreshing… · 刷新中…' : 'Refresh · 刷新'}
        </button>
      </div>

      {error && <p className="error-text">{error}</p>}

      {data === null ? (
        <p className="muted">Loading feedback… · 正在加载反馈…</p>
      ) : data.items.length === 0 ? (
        <p className="muted">No feedback yet for this filter. · 此筛选条件下暂无反馈。</p>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>When · 时间</th>
                <th>Verdict · 结论</th>
                <th>Event · 活动</th>
                <th>Photo · 照片</th>
                <th>User · 用户</th>
                <th>Run · 运行</th>
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
