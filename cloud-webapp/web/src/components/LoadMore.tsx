import { forwardRef } from 'react';
import { useLang } from '../lib/i18n.js';

interface LoadMoreProps {
  /** How many items are currently shown. */
  shownCount: number;
  /** Total items, when known (Find Me has the full set client-side). The
   *  gallery streams pages from the server and doesn't know the total, so it
   *  passes null and we just show a count when finished. */
  total?: number | null;
  /** Whether another page/batch is available. */
  hasMore: boolean;
  /** True while a page is being fetched — shows the spinner + "Loading more…". */
  loading: boolean;
  onLoadMore: () => void;
  /** Singular English noun for the "Showing all N …" line, e.g. "photo". */
  noun?: string;
  /** Chinese noun for the "Showing all N …" line, e.g. "照片". */
  nounZh?: string;
}

/**
 * Shared pagination footer for the photo grids. Shows, in order of state:
 *  - a spinner + "Loading more…" while a batch loads (announced politely);
 *  - a full-width "Load more" button when more is available;
 *  - a quiet "Showing all N …" line once everything is shown.
 *
 * Text follows the app-wide language toggle (lib/i18n). The forwarded ref lets
 * the gallery attach its infinite-scroll Intersection observer to this element.
 */
export const LoadMore = forwardRef<HTMLDivElement, LoadMoreProps>(function LoadMore(
  { shownCount, total = null, hasMore, loading, onLoadMore, noun = 'photo', nounZh = '照片' },
  ref,
): JSX.Element | null {
  const { lang } = useLang();
  if (shownCount === 0 && !loading) return null;
  const enNoun = shownCount === 1 ? noun : `${noun}s`;

  const loadingText = lang === 'zh' ? '正在加载更多…' : 'Loading more…';
  const loadMoreText =
    lang === 'zh'
      ? `加载更多${total != null ? `（${shownCount} / ${total}）` : ''}`
      : `Load more${total != null ? ` (${shownCount} of ${total})` : ''}`;
  const allShownText =
    lang === 'zh'
      ? `已显示全部 ${shownCount} 张${nounZh}。`
      : `Showing all ${shownCount} ${enNoun}.`;

  return (
    <div className="load-more" ref={ref}>
      {loading ? (
        <p className="load-more-status" role="status" aria-live="polite">
          <span className="spinner spinner-sm" aria-hidden="true" />
          {loadingText}
        </p>
      ) : hasMore ? (
        <button type="button" className="btn btn-light load-more-btn" onClick={onLoadMore}>
          {loadMoreText}
        </button>
      ) : (
        <p className="muted">{allShownText}</p>
      )}
    </div>
  );
});
