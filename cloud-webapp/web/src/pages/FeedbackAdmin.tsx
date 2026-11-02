import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type {
  AdminFeedbackResponse,
  FeedbackItem,
  FeedbackVerdict,
  PhotoWebUrlResponse,
} from '@cloud-webapp/shared';
import { Lightbox } from '../components/Lightbox.js';
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
    colRun: 'Search',
    openPhoto: 'Open photo',
    noThumb: 'No preview',
    rank: (n: number) => `#${n}`,
    seeMore: 'see more',
    seeMoreHelp: 'Shown under "see more", below the default cutoff.',
    rankHelp: 'Where the matcher ranked this photo in the search, and its score.',
    onlyEvent: 'Show only this event',
    onlyUser: 'Show only this user',
    userFilter: (who: string) => `User: ${who}`,
    clearUser: 'Clear user filter',
    openSearch: 'Open search →',
    openSearchHelp: 'The selfie searched with and every verdict on that search.',
    noRun: 'Not linked to a search',
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
    colRun: '搜索',
    openPhoto: '打开照片',
    noThumb: '无预览',
    rank: (n: number) => `第 ${n} 位`,
    seeMore: '查看更多',
    seeMoreHelp: '在「查看更多」中显示，低于默认阈值。',
    rankHelp: '该照片在此次搜索中的排名及匹配分数。',
    onlyEvent: '只看此活动',
    onlyUser: '只看此用户',
    userFilter: (who: string) => `用户：${who}`,
    clearUser: '清除用户筛选',
    openSearch: '查看搜索 →',
    openSearchHelp: '搜索所用的自拍，以及该次搜索的全部结论。',
    noRun: '未关联搜索',
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

/** The verdict-batch view for a row's search: selfie + sibling verdicts. */
function searchHref(runId: string): string {
  return `/admin/verdicts?run=${encodeURIComponent(runId)}`;
}

type VerdictFilter = '' | FeedbackVerdict;

/**
 * Admin review queue (dev plan M4.4 / FR-16/FR-17). Renders the
 * `GET /api/admin/feedback` queue so admins can audit wrong/confirmed matches.
 * Server-authoritative: a non-admin caller gets a 403, which we surface as a
 * friendly empty state (mirrors the "Index now" pattern on Events).
 *
 * Built to investigate from, not just to read: each row shows the photo (tap
 * for full size, then page through the queue), the event by name, where the
 * matcher ranked it, and a link into the audited verdict-batch view for the
 * selfie that was searched with. Event and user cells narrow the queue to that
 * event / searcher, which is usually the next question after one bad row.
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
  // Set by tapping a user cell; shown as a removable chip, since a uid is not
  // something anyone types.
  const [user, setUser] = useState<{ uid: string; label: string } | null>(null);

  // Lightbox over the rows in view. The full-size `web` derivative is signed on
  // demand, as in the gallery; until it lands the thumbnail stands in.
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [webUrls, setWebUrls] = useState<Record<string, string>>({});
  const webFetching = useRef<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setForbidden(false);
    setLightboxIndex(null);
    const qs = new URLSearchParams();
    if (eventId.trim()) qs.set('eventId', eventId.trim());
    if (verdict) qs.set('verdict', verdict);
    if (user) qs.set('uid', user.uid);
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
  }, [eventId, verdict, user, t]);

  useEffect(() => {
    void load();
  }, [load]);

  // Lazily sign the full-size URL for whichever photo the lightbox is showing.
  useEffect(() => {
    if (lightboxIndex === null || !data) return;
    const item = data.items[lightboxIndex];
    if (!item) return;
    const key = `${item.eventId}/${item.photoId}`;
    if (webUrls[key] || webFetching.current.has(key)) return;
    webFetching.current.add(key);
    apiGet<PhotoWebUrlResponse>(
      `/api/events/${encodeURIComponent(item.eventId)}/photos/${encodeURIComponent(item.photoId)}/web`,
    )
      .then((r) => setWebUrls((prev) => ({ ...prev, [key]: r.webUrl })))
      .catch(() => webFetching.current.delete(key));
  }, [lightboxIndex, data, webUrls]);

  if (forbidden) {
    return (
      <div>
        <h2>{t.title}</h2>
        <p className="muted">{t.adminOnly}</p>
      </div>
    );
  }

  const items = data?.items ?? [];

  /** "#3 · 4.82" — the matcher's view of a row; empty for unranked votes.
   *  `!= null`, not `!== null`: an api older than this page omits the field. */
  const placement = (item: FeedbackItem): string =>
    [item.rank != null ? t.rank(item.rank) : null, item.score != null ? item.score.toFixed(2) : null]
      .filter(Boolean)
      .join(' · ');

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
        {user && (
          <span className="filter-chip">
            {t.userFilter(user.label)}
            <button
              type="button"
              className="filter-chip-clear"
              onClick={() => setUser(null)}
              aria-label={t.clearUser}
              title={t.clearUser}
            >
              ×
            </button>
          </span>
        )}
        <button className="btn btn-light btn-sm" onClick={() => void load()} disabled={loading}>
          {loading ? t.refreshing : t.refresh}
        </button>
      </div>

      {error && <p className="error-text">{error}</p>}

      {data === null ? (
        <p className="muted">{t.loading}</p>
      ) : items.length === 0 ? (
        <p className="muted">{t.noFeedback}</p>
      ) : (
        <div className="table-wrap">
          <table className="data-table feedback-table">
            <thead>
              <tr>
                <th>{t.colPhoto}</th>
                <th>{t.colVerdict}</th>
                <th>{t.colWhen}</th>
                <th>{t.colEvent}</th>
                <th>{t.colUser}</th>
                <th>{t.colRun}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item, i) => {
                const badge = verdictBadge(item.verdict);
                const where = placement(item);
                const who = item.email ?? item.uid;
                return (
                  <tr key={item.feedbackId}>
                    <td data-label={t.colPhoto}>
                      <button
                        type="button"
                        className="photo-cell feedback-thumb"
                        onClick={() => setLightboxIndex(i)}
                        aria-label={t.openPhoto}
                        title={item.photoId}
                      >
                        {item.thumbUrl ? (
                          <img src={item.thumbUrl} alt={item.photoId} loading="lazy" />
                        ) : (
                          <span className="selfie-missing" aria-hidden="true" />
                        )}
                      </button>
                    </td>
                    <td data-label={t.colVerdict}>
                      <span className="feedback-verdict">
                        <span className={badge.className}>{t[badge.labelKey]}</span>
                        {where && (
                          <span className="muted event-stat" title={t.rankHelp}>
                            {where}
                          </span>
                        )}
                        {item.tier === 'expanded' && (
                          <span className="badge" title={t.seeMoreHelp}>
                            {t.seeMore}
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="muted" data-label={t.colWhen}>{fmtWhen(item.createdAt)}</td>
                    <td data-label={t.colEvent}>
                      <button
                        type="button"
                        className="btn-inline-link"
                        onClick={() => setEventId(item.eventId)}
                        title={`${t.onlyEvent} — ${item.eventId}`}
                      >
                        {item.eventName ?? item.eventId}
                      </button>
                    </td>
                    <td data-label={t.colUser}>
                      <button
                        type="button"
                        className="btn-inline-link"
                        onClick={() => setUser({ uid: item.uid, label: who })}
                        title={t.onlyUser}
                      >
                        {who}
                      </button>
                    </td>
                    <td data-label={t.colRun}>
                      {item.runId ? (
                        <Link
                          to={searchHref(item.runId)}
                          className="inline-link"
                          title={t.openSearchHelp}
                        >
                          {t.openSearch}
                        </Link>
                      ) : (
                        <span className="muted">{t.noRun}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {lightboxIndex !== null && items[lightboxIndex] && (
        <Lightbox
          items={items.map((item) => {
            const badge = verdictBadge(item.verdict);
            return {
              key: item.feedbackId,
              src: webUrls[`${item.eventId}/${item.photoId}`] ?? item.thumbUrl ?? '',
              ...(item.thumbUrl ? { fallbackSrc: item.thumbUrl } : {}),
              alt: item.photoId,
              badge: <span className={badge.className}>{t[badge.labelKey]}</span>,
            };
          })}
          index={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
          onNavigate={setLightboxIndex}
          renderFooter={(_, idx) => {
            const item = items[idx];
            if (!item) return null;
            const where = placement(item);
            return (
              <div className="feedback-lightbox-meta">
                <span>{item.eventName ?? item.eventId}</span>
                <span className="muted">{item.email ?? item.uid}</span>
                {where && <span className="muted">{where}</span>}
                {item.runId && (
                  <Link to={searchHref(item.runId)} className="inline-link">
                    {t.openSearch}
                  </Link>
                )}
              </div>
            );
          }}
        />
      )}
    </div>
  );
}
