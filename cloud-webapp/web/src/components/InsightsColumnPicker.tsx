import { useEffect, useRef, useState } from 'react';
import { ALL_COLUMNS, type ColumnId } from '../lib/uploadInsights.js';
import type { InsightsStrings } from '../lib/uploadInsightsStrings.js';

const GROUPS: ReadonlyArray<{ id: keyof InsightsStrings['columnGroup']; columns: ColumnId[] }> = [
  { id: 'files', columns: ['sessions', 'files', 'copied', 'untracked', 'skippedDuplicates', 'staged', 'failed'] },
  { id: 'index', columns: ['indexed', 'indexRatio'] },
  { id: 'time', columns: ['size', 'minutes', 'firstSessionAt', 'lastSessionAt', 'lastActivityAt'] },
  { id: 'speed', columns: ['mbPerSec', 'filesPerMin'] },
  { id: 'status', columns: ['attention'] },
];

/**
 * "Columns · 12 of 17": a popover of checkboxes, grouped by what the columns
 * measure. Whatever is ticked, the table keeps its own column order.
 */
export function InsightsColumnPicker(props: {
  t: InsightsStrings;
  selected: ReadonlyArray<ColumnId>;
  onChange: (columns: ColumnId[]) => void;
  onReset: () => void;
}): JSX.Element {
  const { t, selected, onChange, onReset } = props;
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const toggle = (c: ColumnId): void =>
    onChange(ALL_COLUMNS.filter((x) => (x === c ? !selected.includes(c) : selected.includes(x))));

  return (
    <div className="insights-picker" ref={root}>
      <button
        type="button"
        className="btn btn-light btn-sm"
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => setOpen((o) => !o)}
      >
        {t.columns(selected.length, ALL_COLUMNS.length)} ▾
      </button>
      {open && (
        <div className="insights-picker-panel" role="group" aria-label={t.columns(selected.length, ALL_COLUMNS.length)}>
          {GROUPS.map((g) => (
            <fieldset key={g.id}>
              <legend>{t.columnGroup[g.id]}</legend>
              {g.columns.map((c) => (
                <label key={c}>
                  <input type="checkbox" checked={selected.includes(c)} onChange={() => toggle(c)} /> {t.col[c]}
                </label>
              ))}
            </fieldset>
          ))}
          <div className="insights-picker-actions">
            <button type="button" className="btn btn-light btn-sm" onClick={() => onChange([...ALL_COLUMNS])}>
              {t.showAll}
            </button>
            <button type="button" className="btn btn-light btn-sm" onClick={onReset}>
              {t.reset}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
