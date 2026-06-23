import { SORT_OPTIONS, type GallerySort } from '../lib/sortMode.js';

interface SortSelectProps {
  value: GallerySort;
  onChange: (s: GallerySort) => void;
  /** Hidden-but-labelled control (screen readers); the visible text is the
   *  selected option label. */
  label?: string;
}

/** Sort-order dropdown for the gallery toolbar. Reuses the page-size select
 *  styling so the two toolbar controls match. */
export function SortSelect({
  value,
  onChange,
  label = 'Sort photos · 排序',
}: SortSelectProps): JSX.Element {
  return (
    <label className="page-size">
      <span className="sr-only">{label}</span>
      <select
        className="page-size-select"
        value={value}
        onChange={(e) => onChange(e.target.value as GallerySort)}
        aria-label={label}
      >
        {SORT_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
