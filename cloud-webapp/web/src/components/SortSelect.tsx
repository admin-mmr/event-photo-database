import { SORT_OPTIONS, type GallerySort } from '../lib/sortMode.js';
import { useStrings } from '../lib/i18n.js';

const STR = {
  en: {
    label: 'Sort photos',
    options: {
      added_desc: 'Time uploaded — newest first',
      added_asc: 'Time uploaded — oldest first',
      taken_desc: 'Time taken — newest first',
      taken_asc: 'Time taken — oldest first',
      name: 'By name',
    } as Record<GallerySort, string>,
  },
  zh: {
    label: '排序',
    options: {
      added_desc: '上传时间——最新优先',
      added_asc: '上传时间——最早优先',
      taken_desc: '拍摄时间——最新优先',
      taken_asc: '拍摄时间——最早优先',
      name: '按名称',
    } as Record<GallerySort, string>,
  },
};

interface SortSelectProps {
  value: GallerySort;
  onChange: (s: GallerySort) => void;
  /** Hidden-but-labelled control (screen readers). Defaults to a toggle-aware
   *  "Sort photos"; the visible text is the selected option label. */
  label?: string;
}

/** Sort-order dropdown for the gallery toolbar. Reuses the page-size select
 *  styling so the two toolbar controls match. Labels follow the language toggle. */
export function SortSelect({ value, onChange, label }: SortSelectProps): JSX.Element {
  const t = useStrings(STR);
  const resolvedLabel = label ?? t.label;
  return (
    <label className="page-size">
      <span className="sr-only">{resolvedLabel}</span>
      <select
        className="page-size-select"
        value={value}
        onChange={(e) => onChange(e.target.value as GallerySort)}
        aria-label={resolvedLabel}
      >
        {SORT_OPTIONS.map((v) => (
          <option key={v} value={v}>
            {t.options[v]}
          </option>
        ))}
      </select>
    </label>
  );
}
