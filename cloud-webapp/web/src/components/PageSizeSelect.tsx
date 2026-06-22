import { PAGE_SIZE_OPTIONS } from '../lib/pageSize.js';

interface PageSizeSelectProps {
  value: number;
  onChange: (n: number) => void;
  /** Hidden-but-labelled control; the visible text is "N / page". */
  label?: string;
  /** The selectable sizes. Defaults to the gallery's; Find Me passes its own
   *  (capped at the per-batch download limit). */
  options?: readonly number[];
}

/** Photos-per-page dropdown used in the gallery and Find Me toolbars. */
export function PageSizeSelect({
  value,
  onChange,
  label = 'Photos per page',
  options = PAGE_SIZE_OPTIONS,
}: PageSizeSelectProps): JSX.Element {
  return (
    <label className="page-size">
      <span className="sr-only">{label}</span>
      <select
        className="page-size-select"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={label}
      >
        {options.map((n) => (
          <option key={n} value={n}>
            {n} / page
          </option>
        ))}
      </select>
    </label>
  );
}
