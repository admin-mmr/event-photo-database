import { forwardRef } from 'react';

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
  /** Singular noun for the "Showing all N …" line, e.g. "photo" / "match". */
  noun?: string;
}

/**
 * Shared pagination footer for the photo grids. Shows, in order of state:
 *  - a spinner + "Loading more…" while a batch loads (announced politely);
 *  - a full-width "Load more" button when more is available;
 *  - a quiet "Showing all N …" line once everything is shown.
 *
 * The forwarded ref lets the gallery attach its infinite-scroll Intersection
 * observer to this element (it doubles as the sentinel).
 */
export const LoadMore = forwardRef<HTMLDivElement, LoadMoreProps>(function LoadMore(
  { shownCount, total = null, hasMore, loading, onLoadMore, noun = 'photo' },
  ref,
): JSX.Element | null {
  if (shownCount === 0 && !loading) return null;
  const plural = (n: number): string => (n === 1 ? noun : `${noun}s`);

  return (
    <div className="load-more" ref={ref}>
      {loading ? (
        <p className="load-more-status" role="status" aria-live="polite">
          <span className="spinner spinner-sm" aria-hidden="true" />
          Loading more…
        </p>
      ) : hasMore ? (
        <button type="button" className="btn btn-light load-more-btn" onClick={onLoadMore}>
          Load more{total != null ? ` (${shownCount} of ${total})` : ''}
        </button>
      ) : (
        <p className="muted">
          Showing all {shownCount} {plural(shownCount)}.
        </p>
      )}
    </div>
  );
});
