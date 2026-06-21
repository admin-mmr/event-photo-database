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
  /**
   * The browser can share files (Web Share L2 — i.e. mobile). When true, the
   * iPhone-friendly "Save to Photos" action becomes the PRIMARY button and the
   * ZIP download is demoted to secondary (§5B C3): a ZIP is the worst case on
   * iOS (lands in Files, can't expand into Photos).
   */
  canSave?: boolean;
  /**
   * The selected originals are still being fetched into memory, so the one-tap
   * "Save to Photos" can't fire a synchronous share yet (iOS requires
   * `navigator.share` to run inside the tap's user activation — see Gallery).
   * While true the Save button shows "Preparing…" and is disabled.
   */
  savePreparing?: boolean;
  onSelectAll: () => void;
  onSelectNone: () => void;
  onInvert: () => void;
  onDownload: () => void;
  /** Save the selection as separate image files (iPhone "Save N to Photos"). */
  onDownloadIndividual?: () => void;
  /** Primary mobile save: hands the image files to the native share sheet. */
  onSaveToPhone?: () => void;
}

export function SelectBar({
  total,
  selectedCount,
  busy = false,
  canSave = false,
  savePreparing = false,
  onSelectAll,
  onSelectNone,
  onInvert,
  onDownload,
  onDownloadIndividual,
  onSaveToPhone,
}: SelectBarProps): JSX.Element {
  const none = selectedCount === 0;
  const all = selectedCount === total && total > 0;
  // On mobile (Web Share L2) the one-tap "Save to Photos" is the headline action
  // and ZIP is the fallback; on desktop ZIP stays primary (§5B C3).
  const saveToPhotos = canSave && onSaveToPhone;
  const zipClass = saveToPhotos ? 'btn btn-light btn-sm' : 'btn btn-primary btn-sm';
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
        {saveToPhotos && (
          <button
            className="btn btn-primary btn-sm"
            onClick={onSaveToPhone}
            disabled={none || busy || savePreparing}
          >
            {busy
              ? 'Saving…'
              : savePreparing
                ? `Preparing ${selectedCount || ''}…`.replace('  ', ' ').trim()
                : `📲 Save ${selectedCount || ''} to Photos`.replace('  ', ' ').trim()}
          </button>
        )}
        <button className={zipClass} onClick={onDownload} disabled={none || busy}>
          {busy && !saveToPhotos ? 'Preparing ZIP…' : `⬇ Download ZIP ${selectedCount || ''}`.trim()}
        </button>
        {onDownloadIndividual && (
          <button
            className="btn btn-light btn-sm"
            onClick={onDownloadIndividual}
            disabled={none || busy}
          >
            🖼 Save individually
          </button>
        )}
      </div>
    </div>
  );
}
