import { useCallback, useEffect, useState } from 'react';
import type {
  DuplicateFile,
  DuplicateScanResponse,
  EventSummary,
  ListEventsResponse,
  RemoveDuplicatesResponse,
} from '@cloud-webapp/shared';
import { apiGet, apiPost, ApiError } from '../lib/api.js';
import { eventLabel } from '../lib/eventLabel.js';
import { useStrings } from '../lib/i18n.js';

const STR = {
  en: {
    title: 'Duplicate files',
    intro:
      'Finds files in an event\'s Google Drive folder that are byte-for-byte identical — the same photo uploaded twice, a card re-imported, a batch copied. One copy of each is kept (the same one the index and gallery use); the rest are moved to Drive\'s trash and listed on the Deleted files page, so nothing is lost.',
    eventLabel: 'Event',
    choose: 'Choose an event…',
    loadingEvents: 'Loading events…',
    scan: 'Scan Drive',
    scanning: 'Scanning Drive…',
    rescan: 'Re-scan',
    remove: 'Move duplicates to trash',
    removing: 'Removing…',
    forbidden: 'This page is admin-only — sign in with an admin account.',
    scanFailed: 'Scan failed.',
    removeFailed: 'Removal failed.',
    noDupes: 'No byte-identical duplicates found. Nothing to clean up.',
    summary: (dupes: number, groups: number, size: string) =>
      `${dupes} duplicate file${dupes === 1 ? '' : 's'} across ${groups} group${groups === 1 ? '' : 's'} — ${size} reclaimable.`,
    scanned: (files: number) => `${files.toLocaleString()} files scanned in Drive.`,
    unhashed: (n: number) =>
      `${n} file${n === 1 ? '' : 's'} had no Drive checksum and were left alone.`,
    confirm: (n: number) =>
      `Move ${n} duplicate file${n === 1 ? '' : 's'} to Drive's trash? The kept copy of each stays put, and anything trashed can be restored from the Deleted files page.`,
    removed: (n: number, size: string) =>
      `Moved ${n} duplicate file${n === 1 ? '' : 's'} to trash — ${size} reclaimed.`,
    working: (done: number, total: number) => `Moving files to trash — ${done} of ${total} done…`,
    partial: (n: number) => `${n} still to go — run it again to continue.`,
    failedSome: (n: number) => `${n} file${n === 1 ? '' : 's'} could not be trashed.`,
    reindexNote:
      'The search index still lists the removed copies until the event is re-indexed (Events → Index event).',
    groupsHead: 'What would be removed',
    kept: 'Kept',
    removeCol: 'Duplicates',
    size: 'Size',
    truncated: (n: number) => `… and ${n} more group${n === 1 ? '' : 's'}.`,
    dryRunNote: 'Scanning changes nothing. Files are only trashed when you press the button below.',
  },
  zh: {
    title: '重复文件',
    intro:
      '查找活动 Google Drive 文件夹中完全相同（逐字节一致）的文件——同一张照片上传两次、存储卡重复导入、批次被复制等。每组保留一份（与索引和相册使用的同一份），其余移入 Drive 回收站并显示在“已删除文件”页面，不会丢失。',
    eventLabel: '活动',
    choose: '选择活动…',
    loadingEvents: '正在加载活动…',
    scan: '扫描 Drive',
    scanning: '正在扫描 Drive…',
    rescan: '重新扫描',
    remove: '将重复文件移入回收站',
    removing: '处理中…',
    forbidden: '此页面仅限管理员，请使用管理员账号登录。',
    scanFailed: '扫描失败。',
    removeFailed: '删除失败。',
    noDupes: '未发现完全相同的重复文件，无需清理。',
    summary: (dupes: number, groups: number, size: string) =>
      `发现 ${dupes} 个重复文件，共 ${groups} 组——可释放 ${size}。`,
    scanned: (files: number) => `已扫描 Drive 中 ${files.toLocaleString()} 个文件。`,
    unhashed: (n: number) => `${n} 个文件没有 Drive 校验值，已保留不动。`,
    confirm: (n: number) =>
      `确定将 ${n} 个重复文件移入 Drive 回收站吗？每组保留的那份不受影响，已移入回收站的文件可在“已删除文件”页面恢复。`,
    removed: (n: number, size: string) => `已将 ${n} 个重复文件移入回收站——释放 ${size}。`,
    working: (done: number, total: number) => `正在移入回收站——已完成 ${done} / ${total}…`,
    partial: (n: number) => `仍有 ${n} 个待处理——再次运行即可继续。`,
    failedSome: (n: number) => `${n} 个文件无法移入回收站。`,
    reindexNote: '在重新索引该活动之前，搜索索引仍会包含已删除的副本（活动 → 建立索引）。',
    groupsHead: '将被删除的文件',
    kept: '保留',
    removeCol: '重复文件',
    size: '大小',
    truncated: (n: number) => `……还有 ${n} 组。`,
    dryRunNote: '扫描不会更改任何内容，只有点击下方按钮才会移入回收站。',
  },
};

/** Human byte size — duplicates are usually MB-scale, so keep it short. */
function fmtBytes(bytes: number): string {
  if (bytes <= 0) return '0 MB';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Groups rendered in the preview table — enough to judge, not a data dump. */
const MAX_GROUPS_SHOWN = 25;

/**
 * Safety stop for the removal loop below. Each round trashes a server-bounded
 * batch, so this is far more rounds than any real event needs — it exists only
 * so a server that kept reporting `remaining` could never spin forever.
 */
const MAX_REMOVE_ROUNDS = 60;

/** Running totals across the rounds of one "Move duplicates to trash" press. */
interface RemovalTotals {
  removed: number;
  failed: number;
  remaining: number;
  bytesReclaimed: number;
  warnings: string[];
  reindexRecommended: boolean;
}

function fileLine(f: DuplicateFile): string {
  return f.relPath || f.name || f.driveFileId;
}

/**
 * Duplicate-file removal tool. Scans an event's live Drive tree for
 * byte-identical copies (GET /api/admin/duplicates/:eventId), previews them, and
 * trashes the redundant ones through the soft-delete lifecycle
 * (POST …/remove with apply:true) so every removal is restorable.
 *
 * Server-side the removal is capped per call and reports what is left, so the
 * button is pressed again for a big event rather than the request timing out.
 * Club-scoped server-side: a club_admin only ever sees their own club's files.
 */
export function AdminDuplicates(): JSX.Element {
  const t = useStrings(STR);
  const [events, setEvents] = useState<EventSummary[] | null>(null);
  const [eventId, setEventId] = useState('');
  const [scan, setScan] = useState<DuplicateScanResponse | null>(null);
  const [result, setResult] = useState<RemovalTotals | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [busy, setBusy] = useState<'scan' | 'remove' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  useEffect(() => {
    apiGet<ListEventsResponse>('/api/events')
      .then((r) => setEvents([...r.events].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))))
      .catch((e) => {
        if (e instanceof ApiError && e.status === 403) setForbidden(true);
        setEvents([]);
      });
  }, []);

  // NB: deliberately does not clear `result` — the re-scan that follows a
  // removal must not wipe the "moved N files to trash" summary the admin just
  // earned. Callers clear it when they mean to (event change, manual re-scan).
  const runScan = useCallback(async (id: string) => {
    setBusy('scan');
    setError(null);
    try {
      const r = await apiGet<DuplicateScanResponse>(`/api/admin/duplicates/${encodeURIComponent(id)}`);
      setScan(r);
    } catch (e) {
      setScan(null);
      if (e instanceof ApiError && e.status === 403) setForbidden(true);
      else setError(e instanceof Error ? e.message : t.scanFailed);
    } finally {
      setBusy(null);
    }
  }, [t.scanFailed]);

  /**
   * Trash every duplicate in the event, one press.
   *
   * The server trashes a bounded batch per call — it has to, since the whole
   * request must fit Firebase Hosting's 60s ceiling — and reports what is left
   * in `remaining`. So keep calling while it makes progress instead of asking
   * the admin to press the button once per batch (an event with a few hundred
   * duplicates needs several rounds). A round that removes nothing means every
   * remaining file is failing, so stop rather than retry the same files forever.
   */
  async function remove(): Promise<void> {
    if (!scan || scan.duplicateFiles === 0) return;
    if (!window.confirm(t.confirm(scan.duplicateFiles))) return;
    const eventId = scan.eventId;
    const totals: RemovalTotals = {
      removed: 0,
      failed: 0,
      remaining: 0,
      bytesReclaimed: 0,
      warnings: [],
      reindexRecommended: false,
    };
    setBusy('remove');
    setError(null);
    setResult(null);
    setProgress({ done: 0, total: scan.duplicateFiles });
    try {
      for (let round = 0; round < MAX_REMOVE_ROUNDS; round += 1) {
        const r = await apiPost<RemoveDuplicatesResponse>(
          `/api/admin/duplicates/${encodeURIComponent(eventId)}/remove`,
          { apply: true },
        );
        totals.removed += r.removed;
        totals.failed += r.failed;
        totals.bytesReclaimed += r.bytesReclaimed;
        totals.remaining = r.remaining;
        totals.reindexRecommended = totals.reindexRecommended || r.reindexRecommended;
        for (const w of r.warnings) if (!totals.warnings.includes(w)) totals.warnings.push(w);
        setProgress({ done: totals.removed, total: totals.removed + r.remaining });
        if (r.remaining === 0 || r.removed === 0) break;
      }
      setResult({ ...totals, warnings: [...totals.warnings] });
      // Re-scan so the table reflects Drive as it is now.
      await runScan(eventId);
    } catch (e) {
      // Whatever earlier rounds trashed is real — show it alongside the error
      // rather than losing it.
      if (totals.removed > 0) setResult({ ...totals, warnings: [...totals.warnings] });
      setError(e instanceof Error ? e.message : t.removeFailed);
    } finally {
      setProgress(null);
      setBusy(null);
    }
  }

  if (forbidden) {
    return (
      <div>
        <h2>{t.title}</h2>
        <p className="muted">{t.forbidden}</p>
      </div>
    );
  }

  const shown = scan?.groups.slice(0, MAX_GROUPS_SHOWN) ?? [];
  const hiddenGroups = Math.max(0, (scan?.groups.length ?? 0) - shown.length);

  return (
    <div>
      <div className="gallery-header">
        <h2>{t.title}</h2>
      </div>
      <p className="muted">{t.intro}</p>

      <div className="feedback-filters">
        <label>
          {t.eventLabel}{' '}
          <select
            className="feedback-input"
            value={eventId}
            disabled={events === null || busy !== null}
            onChange={(e) => {
              setEventId(e.target.value);
              setScan(null);
              setResult(null);
              setError(null);
            }}
          >
            <option value="">{events === null ? t.loadingEvents : t.choose}</option>
            {(events ?? []).map((ev) => (
              <option key={ev.id} value={ev.id}>
                {eventLabel({ name: ev.name, date: ev.date, id: ev.id })}
              </option>
            ))}
          </select>
        </label>
        <button
          className="btn btn-light btn-sm"
          disabled={!eventId || busy !== null}
          onClick={() => {
            setResult(null);
            void runScan(eventId);
          }}
        >
          {busy === 'scan' ? t.scanning : scan ? t.rescan : t.scan}
        </button>
      </div>

      {error && <p className="error-text">{error}</p>}

      {progress && (
        <p className="muted" role="status" aria-live="polite">
          {t.working(progress.done, progress.total)}
        </p>
      )}

      {result && (
        <div className="rebuild-progress" role="status" aria-live="polite">
          <p>{t.removed(result.removed, fmtBytes(result.bytesReclaimed))}</p>
          {result.remaining > 0 && <p>{t.partial(result.remaining)}</p>}
          {result.failed > 0 && <p className="error-text">{t.failedSome(result.failed)}</p>}
          {result.reindexRecommended && <p className="muted">{t.reindexNote}</p>}
          {result.warnings.map((w) => (
            <p key={w} className="muted">
              {w}
            </p>
          ))}
        </div>
      )}

      {scan && (
        <>
          <p className="muted">{t.scanned(scan.filesScanned)}</p>
          {scan.duplicateFiles === 0 ? (
            <p>{t.noDupes}</p>
          ) : (
            <>
              <p>
                <strong>{t.summary(scan.duplicateFiles, scan.groups.length, fmtBytes(scan.reclaimableBytes))}</strong>
              </p>
              {scan.unhashedFiles > 0 && <p className="muted">{t.unhashed(scan.unhashedFiles)}</p>}
              <p className="muted">{t.dryRunNote}</p>
              <button className="btn btn-primary" disabled={busy !== null} onClick={() => void remove()}>
                {busy === 'remove' ? t.removing : t.remove}
              </button>

              <h3>{t.groupsHead}</h3>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>{t.kept}</th>
                      <th>{t.removeCol}</th>
                      <th>{t.size}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((g) => (
                      <tr key={g.contentHash}>
                        <td data-label={t.kept}>{fileLine(g.canonical)}</td>
                        <td data-label={t.removeCol}>
                          {g.duplicates.map((d) => (
                            <div key={d.driveFileId}>{fileLine(d)}</div>
                          ))}
                        </td>
                        <td className="muted" data-label={t.size}>
                          {fmtBytes(g.duplicates.reduce((n, d) => n + d.sizeBytes, 0))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {hiddenGroups > 0 && <p className="muted">{t.truncated(hiddenGroups)}</p>}
            </>
          )}
        </>
      )}
    </div>
  );
}
