import { PAGE_SIZE_OPTIONS } from '../lib/pageSize.js';
import { useLang } from '../lib/i18n.js';

interface PageSizeSelectProps {
  value: number;
  onChange: (n: number) => void;
  /** Hidden-but-labelled control. Defaults to a toggle-aware "Photos per page";
   *  callers (e.g. Find Me) may override with their own localized label. */
  label?: string;
  /** The selectable sizes. Defaults to the gallery's; Find Me passes its own
   *  (capped at the per-batch download limit). */
  options?: readonly number[];
}

/** Photos-per-page dropdown used in the gallery and Find Me toolbars. */
export function PageSizeSelect({
  value,
  onChange,
  label,
  options = PAGE_SIZE_OPTIONS,
}: PageSizeSelectProps): JSX.Element {
  const { lang } = useLang();
  const resolvedLabel = label ?? (lang === 'zh' ? '每页照片数' : 'Photos per page');
  return (
    <label className="page-size">
      <span className="sr-only">{resolvedLabel}</span>
      <select
        className="page-size-select"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={resolvedLabel}
      >
        {options.map((n) => (
          <option key={n} value={n}>
            {lang === 'zh' ? `${n} / 页` : `${n} / page`}
          </option>
        ))}
      </select>
    </label>
  );
}
