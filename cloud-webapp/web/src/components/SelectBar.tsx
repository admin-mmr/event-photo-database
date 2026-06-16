/**
 * SelectBar — sticky action bar for selectable photo grids (dev plan §5A B2).
 *
 * Drives the B1 batch download: shows the selection count and the
 * Select all / Select none / Invert controls plus the "Download originals"
 * button. Keyboard-accessible (plain <button>s, visible focus, aria-live count).
 */

interface SelectBarProps {
  total: number;
  selectedCount: number;
  busy?: boolean;
  onSelectAll: () => void;
  onSelectNone: () => void;
  onInvert: () => void;
  onDownload: () => void;
}

export function SelectBar({
  total,
  selectedCount,
  busy = false,
  onSelectAll,
  onSelectNone,
  onInvert,
  onDownload,
}: SelectBarProps): JSX.Element {
  const none = selectedCount === 0;
  const all = selectedCount === total && total > 0;
  return (
    <div className="select-bar" role="toolbar" aria-label="Photo selection">
      <span className="select-count" aria-live="polite">
        {selectedCount} of {total} selected
      </span>
      <div className="select-actions">
        <button className="btn btn-light btn-sm" onClick={onSelectAll} disabled={all || busy}>
          Select all
        </button>
        <button className="btn btn-light btn-sm" onClick={onSelectNone} disabled={none || busy}>
          Select none
        </button>
        <button className="btn btn-light btn-sm" onClick={onInvert} disabled={total === 0 || busy}>
          Invert
        </button>
        <button className="btn btn-primary btn-sm" onClick={onDownload} disabled={none || busy}>
          {busy ? 'Preparing ZIP…' : `⬇ Download ${selectedCount || ''}`.trim()}
        </button>
      </div>
    </div>
  );
}
