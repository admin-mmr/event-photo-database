import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  DuplicateFile,
  DuplicateScanResponse,
  EventSummary,
  ListEventsResponse,
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
    queueing: 'Queuing the cleanup…',
    sweeping: 'Tidying up the managed folders…',
    keepOpen:
      'This runs in the background — keep the page open and it goes faster. If you navigate away, a scheduled job finishes the rest on its own.',
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
    queueing: '正在加入清理队列…',
    sweeping: '正在整理托管文件夹…',
    keepOpen: '清理在后台进行——保持此页面打开会更快。若离开页面，计划任务会自动完成剩余部分。',
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
 * Safety stop for the drain loop below. Each tick removes a server-bounded slice,
 * so this is far more ticks than any real event needs — it exists only so a
 * server that never reported `done` could not spin forever.
 */
const MAX_DRAIN_TICKS = 400;

/** Pause between drain ticks, so a finished batch is noticed promptly without
 *  hammering the endpoint when there is nothing left to do. */
const TICK_PAUSE_MS = 1200;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Server-side progress of one queued removal (GET …/duplicates/batch/status).
 * Mirrors the batch doc minus its work list, which is far too big to ship.
 */
interface RemovalBatch {
  id: string;
  eventId: string;
  status: 'running' | 'done';
  total: number;
  removed: number;
  failed: number;
  /** Files still queued to trash. */
  remaining: number;
  /** Trashed files whose managed shortcuts are not retired yet. */
  sweepPending: number;
  bytesReclaimed: number;
  /** Duplicates found beyond the batch cap — a second run clears them. */
  notEnqueued: number;
  warnings: string[];
}

function fileLine(f: DuplicateFile): string {
  return f.relPath || f.name || f.driveFileId;
}

/**
 * Duplicate-file removal tool. Scans an event's live Drive tree for
 * byte-identical copies (GET /api/admin/duplicates/:eventId), previews them, and
 * trashes the redundant ones through the soft-delete lifecycle so every removal
 * is restorable.
 *
 * Removal is ASYNC: `POST …/remove {apply:true}` queues a batch and answers 202,
 * then this page drives bounded drain ticks and polls progress. It cannot be one
 * request — an event's duplicates are minutes of rate-paced Drive work, so the
 * old inline call died at the 60s ceiling (HTTP 502) on every press while files
 * were being trashed unseen. Closing the page is safe: a Cloud Scheduler drain
 * finishes the batch.
 *
 * Club-scoped server-side: a club_admin only ever sees their own club's files.
 */
export function AdminDuplicates(): JSX.Element {
  const t = useStrings(STR);
  const [events, setEvents] = useState<EventSummary[] | null>(null);
  const [eventId, setEventId] = useState('');
  const [scan, setScan] = useState<DuplicateScanResponse | null>(null);
  const [batch, setBatch] = useState<RemovalBatch | null>(null);
  const [busy, setBusy] = useState<'scan' | 'remove' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  // Bumped on unmount / new run so an in-flight drive loop knows to stop.
  const runToken = useRef(0);

  useEffect(() => () => void (runToken.current += 1), []);

  useEffect(() => {
    apiGet<ListEventsResponse>('/api/events')
      .then((r) => setEvents([...r.events].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))))
      .catch((e) => {
        if (e instanceof ApiError && e.status === 403) setForbidden(true);
        setEvents([]);
      });
  }, []);

  // NB: deliberately does not clear `batch` — the re-scan that follows a removal
  // must not wipe the "moved N files to trash" summary the admin just earned.
  // Callers clear it when they mean to (event change, manual re-scan).
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
   * Drive a queued batch to completion: trigger a drain tick, read progress,
   * repeat until the server says done.
   *
   * Drain errors are swallowed — a tick that dies leaves its lease to expire and
   * the next tick (or the Cloud Scheduler backstop) resumes, so giving up on the
   * whole run because one call hiccuped would be wrong.
   */
  const driveBatch = useCallback(async (batchId: string, token: number): Promise<void> => {
    const statusUrl = `/api/admin/duplicates/batch/status?batchId=${encodeURIComponent(batchId)}`;
    for (let tick = 0; tick < MAX_DRAIN_TICKS; tick += 1) {
      if (runToken.current !== token) return;
      try {
        await apiPost('/api/admin/duplicates/drain', {});
      } catch {
        /* transient — the next tick (or the scheduler) picks it up */
      }
      if (runToken.current !== token) return;
      try {
        const r = await apiGet<{ ok: true; batch: RemovalBatch | null }>(statusUrl);
        if (r.batch) setBatch(r.batch);
        if (r.batch?.status === 'done') return;
      } catch {
        /* transient — keep going */
      }
      await sleep(TICK_PAUSE_MS);
    }
  }, []);

  /**
   * Queue the event's duplicates for removal, then drive the drain to the end.
   * One press does the whole event; the admin just watches the progress line.
   */
  async function remove(): Promise<void> {
    if (!scan || scan.duplicateFiles === 0) return;
    if (!window.confirm(t.confirm(scan.duplicateFiles))) return;
    const eventId = scan.eventId;
    const token = (runToken.current += 1);
    setBusy('remove');
    setError(null);
    setBatch(null);
    try {
      const queued = await apiPost<{
        ok: true;
        mode: 'async' | 'none';
        batchId: string | null;
        total: number;
        notEnqueued: number;
      }>(`/api/admin/duplicates/${encodeURIComponent(eventId)}/remove`, { apply: true });

      if (queued.mode === 'async' && queued.batchId) {
        setBatch({
          id: queued.batchId,
          eventId,
          status: 'running',
          total: queued.total,
          removed: 0,
          failed: 0,
          remaining: queued.total,
          sweepPending: 0,
          bytesReclaimed: 0,
          notEnqueued: queued.notEnqueued,
          warnings: [],
        });
        await driveBatch(queued.batchId, token);
      }
      if (runToken.current !== token) return;
      // Re-scan so the table reflects Drive as it is now.
      await runScan(eventId);
    } catch (e) {
      // Whatever the batch already trashed is real and still on screen — show the
      // error alongside it rather than replacing it.
      setError(e instanceof Error ? e.message : t.removeFailed);
    } finally {
      if (runToken.current === token) setBusy(null);
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
              setBatch(null);
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
            setBatch(null);
            void runScan(eventId);
          }}
        >
          {busy === 'scan' ? t.scanning : scan ? t.rescan : t.scan}
        </button>
      </div>

      {error && <p className="error-text">{error}</p>}

      {busy === 'remove' && !batch && (
        <p className="muted" role="status" aria-live="polite">
          {t.queueing}
        </p>
      )}

      {batch && (
        <div className="rebuild-progress" role="status" aria-live="polite">
          {batch.status === 'running' ? (
            <>
              <p>
                {batch.remaining === 0 && batch.sweepPending > 0
                  ? t.sweeping
                  : t.working(batch.removed, batch.total)}
              </p>
              <p className="muted">{t.keepOpen}</p>
            </>
          ) : (
            <p>{t.removed(batch.removed, fmtBytes(batch.bytesReclaimed))}</p>
          )}
          {batch.notEnqueued > 0 && <p>{t.partial(batch.notEnqueued)}</p>}
          {batch.failed > 0 && <p className="error-text">{t.failedSome(batch.failed)}</p>}
          {batch.status === 'done' && batch.removed > 0 && <p className="muted">{t.reindexNote}</p>}
          {batch.warnings.map((w) => (
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
