import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { AdminFeedbackResponse, FeedbackItem, FeedbackVerdict } from '@cloud-webapp/shared';
import { apiGet, ApiError } from '../lib/api.js';
import { useStrings } from '../lib/i18n.js';

const STR = {
  en: {
    title: 'Match feedback',
    adminOnly:
      'This review queue is admin-only — sign in with an admin account to view it.',
    confirmed: (n: number) => `${n} confirmed`,
    wrong: (n: number) => `${n} wrong`,
    inView: (n: number) => `${n} in view`,
    filterByEvent: 'Filter by event ID',
    filterByVerdict: 'Filter by verdict',
    allVerdicts: 'All verdicts',
    wrongMatch: 'Wrong match',
    thatsMe: "That's me",
    refreshing: 'Refreshing…',
    refresh: 'Refresh',
    couldNotLoad: 'Could not load feedback.',
    loading: 'Loading feedback…',
    noFeedback: 'No feedback yet for this filter.',
    colWhen: 'When',
    colVerdict: 'Verdict',
    colEvent: 'Event',
    colPhoto: 'Photo',
    colUser: 'User',
    colRun: 'Run',
  },
  zh: {
    title: '匹配反馈',
    adminOnly: '此审核队列仅限管理员，请使用管理员账号登录查看。',
    confirmed: (n: number) => `${n} 已确认`,
    wrong: (n: number) => `${n} 错误`,
    inView: (n: number) => `共 ${n} 条`,
    filterByEvent: '按活动 ID 筛选',
    filterByVerdict: '按结论筛选',
    allVerdicts: '全部结论',
    wrongMatch: '匹配错误',
    thatsMe: '是我',
    refreshing: '刷新中…',
    refresh: '刷新',
    couldNotLoad: '无法加载反馈。',
    loading: '正在加载反馈…',
    noFeedback: '此筛选条件下暂无反馈。',
    colWhen: '时间',
    colVerdict: '结论',
    colEvent: '活动',
    colPhoto: '照片',
    colUser: '用户',
    colRun: '运行',
  },
};

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

function verdictBadge(v: FeedbackVerdict): { labelKey: 'thatsMe' | 'wrongMatch'; className: string } {
  return v === 'confirmed'
    ? { labelKey: 'thatsMe', className: 'badge badge-ok' }
    : { labelKey: 'wrongMatch', className: 'badge badge-err' };
}

type VerdictFilter = '' | FeedbackVerdict;

/**
 * Admin review queue (dev plan M4.4 / FR-16/FR-17). Renders the
 * `GET /api/admin/feedback` queue so admins can audit wrong/confirmed matches.
 * Server-authoritative: a non-admin caller gets a 403, which we surface as a
 * friendly empty state (mirrors the "Index now" pattern on Events).
 */
export function FeedbackAdmin(): JSX.Element {
  const t = useStrings(STR);
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
        setError(e instanceof Error ? e.message : t.couldNotLoad);
      }
    } finally {
      setLoading(false);
    }
  }, [eventId, verdict, t]);

  useEffect(() => {
    void load();
  }, [load]);

  if (forbidden) {
    return (
      <div>
        <h2>{t.title}</h2>
        <p className="muted">{t.adminOnly}</p>
      </div>
    );
  }

  return (
    <div>
      <div className="gallery-header">
        <h2>{t.title}</h2>
        {data && (
          <div className="event-meta">
            <span className="badge badge-ok">{t.confirmed(data.counts.confirmed)}</span>
            <span className="badge badge-err">{t.wrong(data.counts.not_me)}</span>
            <span className="muted event-stat">{t.inView(data.total)}</span>
          </div>
        )}
      </div>

      <div className="feedback-filters">
        <input
          className="feedback-input"
          type="text"
          placeholder={t.filterByEvent}
          value={eventId}
          onChange={(e) => setEventId(e.target.value)}
        />
        <select
          className="feedback-input"
          value={verdict}
          onChange={(e) => setVerdict(e.target.value as VerdictFilter)}
          aria-label={t.filterByVerdict}
        >
          <option value="">{t.allVerdicts}</option>
          <option value="not_me">{t.wrongMatch}</option>
          <option value="confirmed">{t.thatsMe}</option>
        </select>
        <button className="btn btn-light btn-sm" onClick={() => void load()} disabled={loading}>
          {loading ? t.refreshing : t.refresh}
        </button>
      </div>

      {error && <p className="error-text">{error}</p>}

      {data === null ? (
        <p className="muted">{t.loading}</p>
      ) : data.items.length === 0 ? (
        <p className="muted">{t.noFeedback}</p>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>{t.colWhen}</th>
                <th>{t.colVerdict}</th>
                <th>{t.colEvent}</th>
                <th>{t.colPhoto}</th>
                <th>{t.colUser}</th>
                <th>{t.colRun}</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((item: FeedbackItem) => {
                const badge = verdictBadge(item.verdict);
                return (
                  <tr key={item.feedbackId}>
                    <td className="muted" data-label={t.colWhen}>{fmtWhen(item.createdAt)}</td>
                    <td data-label={t.colVerdict}>
                      <span className={badge.className}>{t[badge.labelKey]}</span>
                    </td>
                    <td data-label={t.colEvent}>
                      <Link to={`/events/${item.eventId}`} className="event-link">
                        {item.eventId}
                      </Link>
                    </td>
                    <td className="mono" data-label={t.colPhoto}>{item.photoId}</td>
                    <td data-label={t.colUser}>{item.email ?? item.uid}</td>
                    <td className="mono muted" data-label={t.colRun}>{item.runId ?? '—'}</td>
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
