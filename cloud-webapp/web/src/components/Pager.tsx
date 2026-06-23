/**
 * Pager — numbered page navigation for the Find Me results.
 *
 * Find Me holds the full ranked result list client-side and shows it one page
 * at a time. Unlike the gallery's "Load more" (which grows one cumulative
 * window), this jumps between discrete pages so "Select all" can mean "the
 * current page only" and each download stays one batch.
 *
 * Renders Prev / numbered pages / Next. For long result sets the number strip
 * is windowed around the current page with ellipses, always showing the first
 * and last page. Pages are 0-indexed in props; the labels are 1-indexed.
 *
 * Visible Prev/Next text follows the app-wide language toggle (lib/i18n); the
 * aria-labels stay in English as stable, language-neutral control names.
 */
import { useLang } from '../lib/i18n.js';

interface PagerProps {
  /** Current page, 0-indexed. */
  page: number;
  /** Total number of pages (>= 1). */
  pageCount: number;
  onChange: (page: number) => void;
}

/** Build the 1-indexed page numbers to show, inserting -1 as an ellipsis gap. */
function pageWindow(current: number, total: number): number[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const cur = current + 1; // to 1-indexed
  const pages = new Set<number>([1, total, cur, cur - 1, cur + 1]);
  const sorted = [...pages].filter((p) => p >= 1 && p <= total).sort((a, b) => a - b);
  const out: number[] = [];
  let prev = 0;
  for (const p of sorted) {
    if (prev && p - prev > 1) out.push(-1); // ellipsis
    out.push(p);
    prev = p;
  }
  return out;
}

export function Pager({ page, pageCount, onChange }: PagerProps): JSX.Element | null {
  const { lang } = useLang();
  if (pageCount <= 1) return null;
  const items = pageWindow(page, pageCount);
  const prevText = lang === 'zh' ? '← 上一页' : '← Prev';
  const nextText = lang === 'zh' ? '下一页 →' : 'Next →';

  return (
    <nav className="pager" aria-label="Result pages">
      <button
        type="button"
        className="btn btn-light btn-sm"
        onClick={() => onChange(page - 1)}
        disabled={page === 0}
        aria-label="Previous page"
      >
        {prevText}
      </button>
      <ul className="pager-pages">
        {items.map((p, i) =>
          p === -1 ? (
            <li key={`gap-${i}`} className="pager-gap" aria-hidden="true">
              …
            </li>
          ) : (
            <li key={p}>
              <button
                type="button"
                className={`btn btn-sm pager-num${p - 1 === page ? ' active' : ''}`}
                onClick={() => onChange(p - 1)}
                aria-label={`Page ${p}`}
                aria-current={p - 1 === page ? 'page' : undefined}
              >
                {p}
              </button>
            </li>
          ),
        )}
      </ul>
      <button
        type="button"
        className="btn btn-light btn-sm"
        onClick={() => onChange(page + 1)}
        disabled={page >= pageCount - 1}
        aria-label="Next page"
      >
        {nextText}
      </button>
    </nav>
  );
}
