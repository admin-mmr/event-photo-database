import { PAGE_SIZE_OPTIONS } from '../lib/pageSize.js';

interface PageSizeSelectProps {
  value: number;
  onChange: (n: number) => void;
  /** Hidden-but-labelled control; the visible text is "N / page". */
  label?: string;
}

/** Photos-per-page dropdown used in the gallery and Find Me toolbars. */
export function PageSizeSelect({
  value,
  onChange,
  label = 'Photos per page',
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
        {PAGE_SIZE_OPTIONS.map((n) => (
          <option key={n} value={n}>
            {n} / page
          </option>
        ))}
      </select>
    </label>
  );
}
