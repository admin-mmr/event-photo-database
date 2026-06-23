/**
 * SelectBar — sticky action bar for selectable photo grids (dev plan §5A B2).
 *
 * Drives the B1 batch download: shows the selection count and the
 * Select all / Select none / Invert controls plus the "Download originals"
 * button. Keyboard-accessible (plain <button>s, visible focus, aria-live count).
 *
 * Strings follow the app-wide language toggle via `useStrings` (lib/i18n).
 */
import { useStrings } from '../lib/i18n.js';

const STR = {
  en: {
    countSelected: (s: number, t: number): string => `${s} of ${t} selected`,
    selectAll: 'Select all',
    selectNone: 'Select none',
    invert: 'Invert',
    saving: 'Saving…',
    savingN: (d: number, t: number): string => `Saving ${d} of ${t}…`,
    preparing: (n: number): string => `Preparing ${n || ''}…`.replace('  ', ' ').trim(),
    preparingN: (d: number, t: number): string => `Preparing ${d} of ${t}…`,
    saveToPhotos: (n: number): string => `📲 Save ${n || ''} to Photos`.replace('  ', ' ').trim(),
    preparingZip: 'Preparing ZIP…',
    downloadZip: (n: number): string => `⬇ Download ZIP ${n || ''}`.trim(),
    savePhotos: '🖼 Save photos',
  },
  zh: {
    countSelected: (s: number, t: number): string => `已选 ${s}/${t}`,
    selectAll: '全选',
    selectNone: '取消全选',
    invert: '反选',
    saving: '保存中…',
    savingN: (d: number, t: number): string => `保存中 ${d}/${t}…`,
    preparing: (n: number): string => `准备中 ${n || ''}…`.replace('  ', ' ').trim(),
    preparingN: (d: number, t: number): string => `准备中 ${d}/${t}…`,
    saveToPhotos: (n: number): string => `📲 保存 ${n || ''} 张到相册`.replace('  ', ' ').trim(),
    preparingZip: '正在准备 ZIP…',
    downloadZip: (n: number): string => `⬇ 下载 ZIP ${n || ''}`.trim(),
    savePhotos: '🖼 逐张保存',
  },
};

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
  /**
   * Live progress while the selected originals are being fetched for "Save to
   * Photos". When set, the Save button shows "Saving N of M…" so a large
   * selection doesn't look frozen.
   */
  saveProgress?: { done: number; total: number } | null;
  onSelectAll: () => void;
  onSelectNone: () => void;
  onInvert: () => void;
  onDownload: () => void;
  /** Save the selection as separate image files (iPhone "Save N to Photos"). */
  onDownloadIndividual?: () => void;
  /** Primary mobile save: hands the image files to the native share sheet. */
  onSaveToPhone?: () => void;
  /** Label for the select-all button. Find Me pages results and selects only
   *  the current page, so it passes a localized "Select page". Defaults to the
   *  toggle-aware "Select all". */
  selectAllLabel?: string;
}

export function SelectBar({
  total,
  selectedCount,
  busy = false,
  canSave = false,
  savePreparing = false,
  saveProgress = null,
  onSelectAll,
  onSelectNone,
  onInvert,
  onDownload,
  onDownloadIndividual,
  onSaveToPhone,
  selectAllLabel,
}: SelectBarProps): JSX.Element {
  const t = useStrings(STR);
  const none = selectedCount === 0;
  const all = selectedCount === total && total > 0;
  // On mobile (Web Share L2) the one-tap "Save to Photos" is the headline action
  // and ZIP is the fallback; on desktop ZIP stays primary (§5B C3).
  const saveToPhotos = canSave && onSaveToPhone;
  const zipClass = saveToPhotos ? 'btn btn-light btn-sm' : 'btn btn-primary btn-sm';
  return (
    <div className="select-bar" role="toolbar" aria-label="Photo selection">
      <span className="select-count" aria-live="polite">
        {t.countSelected(selectedCount, total)}
      </span>
      <div className="select-actions">
        <button className="btn btn-light btn-sm" onClick={onSelectAll} disabled={all || busy}>
          {selectAllLabel ?? t.selectAll}
        </button>
        <button className="btn btn-light btn-sm" onClick={onSelectNone} disabled={none || busy}>
          {t.selectNone}
        </button>
        <button className="btn btn-light btn-sm" onClick={onInvert} disabled={total === 0 || busy}>
          {t.invert}
        </button>
        {saveToPhotos && (
          <button
            className="btn btn-primary btn-sm"
            onClick={onSaveToPhone}
            disabled={none || busy || savePreparing}
          >
            {busy
              ? saveProgress
                ? t.savingN(saveProgress.done, saveProgress.total)
                : t.saving
              : savePreparing
                ? saveProgress
                  ? t.preparingN(saveProgress.done, saveProgress.total)
                  : t.preparing(selectedCount)
                : t.saveToPhotos(selectedCount)}
          </button>
        )}
        <button className={zipClass} onClick={onDownload} disabled={none || busy}>
          {busy && !saveToPhotos ? t.preparingZip : t.downloadZip(selectedCount)}
        </button>
        {onDownloadIndividual && (
          <button
            className="btn btn-light btn-sm"
            onClick={onDownloadIndividual}
            disabled={none || busy}
          >
            {t.savePhotos}
          </button>
        )}
      </div>
    </div>
  );
}
