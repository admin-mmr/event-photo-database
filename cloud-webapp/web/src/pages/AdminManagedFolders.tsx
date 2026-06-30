import { useCallback, useEffect, useRef, useState } from 'react';
import type { EventSummary, ListEventsResponse } from '@cloud-webapp/shared';
import { apiGet, apiPost, ApiError } from '../lib/api.js';
import { eventLabel } from '../lib/eventLabel.js';
import { useStrings } from '../lib/i18n.js';

const STR = {
  en: {
    title: 'Managed folders',
    intro:
      'Re-run the post-upload folder pipeline manually when the automatic run failed. These rebuild the Photos / Videos / Album folders and refresh the public folder index. Drive calls are throttled, so a full rebuild can take a while.',
    eventLabel: 'Event',
    allEvents: 'All events',
    loadingEvents: 'Loading events…',
    refreshPublic: 'Refresh public index',
    rebuildOne: 'Rebuild this event',
    rebuildPhotos: 'Rebuild Photos',
    rebuildVideosAlbums: 'Rebuild Videos + Albums',
    migrate: 'Migrate photo shortcuts',
    backfill: 'Backfill sharing',
    dedupe: 'Remove duplicate folders',
    dedupeDone: (folders: number, rows: number) =>
      `Removed ${folders} duplicate folder${folders === 1 ? '' : 's'} and ${rows} stale row${rows === 1 ? '' : 's'}.`,
    running: 'Running…',
    forbidden: 'This page is admin-only — sign in with an admin account.',
    notEnabled: 'Managed folders are not enabled on the server (MANAGED_FOLDERS_ENABLED).',
    done: 'Done.',
    queued: 'Queued — running in the background. It continues even if you close this page.',
    progressHead: 'Rebuild progress',
    overall: (done: number, total: number) => `Step ${Math.min(done + 1, total)} of ${total}`,
    overallDone: 'All steps complete',
    batchProgress: (done: number, failed: number, total: number) =>
      `${done} done, ${failed} failed, of ${total} events`,
    batchDone: (done: number, failed: number, total: number) =>
      `Finished: ${done} rebuilt, ${failed} failed (of ${total} events).`,
    allEventsHint: 'For "All events", Photos / Videos + Albums / Migrate run in the background.',
    managedAlbumsLink: '📑 Open Managed Albums sheet',
    managedAlbumsHint: 'Public, view-only index of every Photo / Video / Album folder — each row links to the raw Google Drive folder. Share this with attendees.',
    elapsed: (s: string) => `Elapsed ${s}`,
    // Step labels + sub-notes
    stepCount: 'Count photos & videos',
    stepPhotos: 'Build Photos_NNN folders',
    stepVideos: 'Build Videos folders',
    stepAlbums: 'Build Album folders',
    stepPublic: 'Update Managed Albums public sheet',
    counting: 'Counting…',
    photosCount: (n: number) => `${n.toLocaleString()} photos`,
    foldersBuilt: (n: number) => `${n} folder${n === 1 ? '' : 's'}`,
    scopesBuilt: (n: number) => `${n} folder${n === 1 ? '' : 's'} across scopes`,
    rowsWritten: (n: number) => `${n} row${n === 1 ? '' : 's'} written`,
    stPending: 'Waiting',
    stRunning: 'Running…',
    stFailed: 'Failed',
    // Reconciliation line
    reconChecking: 'Checking counts…',
    reconSource: 'Source',
    reconFolders: 'In Photos_NNN',
    reconVideos: 'Videos',
    reconIndexed: 'Indexed',
    reconFaces: (faces: number, photos: number) => `${faces} faces / ${photos} photos`,
    reconDupes: (n: number) => `${n} duplicate${n === 1 ? '' : 's'}`,
    reconNoIndex: 'not indexed yet',
    reconRefresh: 'Refresh counts',
    reconNote: 'Fewer indexed faces than photos is normal — only photos with a detectable face are indexed.',
    photosUnit: (n: number) => `${n.toLocaleString()} photos`,
    videosUnit: (n: number) => `${n} videos`,
  },
  zh: {
    title: '托管文件夹',
    intro:
      '当自动流程失败时，可在此手动重新运行上传后的文件夹处理：重建 Photos / Videos / Album 文件夹并刷新公开文件夹索引。Drive 调用已限速，完整重建可能需要一些时间。',
    eventLabel: '活动',
    allEvents: '全部活动',
    loadingEvents: '正在加载活动…',
    refreshPublic: '刷新公开索引',
    rebuildOne: '重建此活动',
    rebuildPhotos: '重建 Photos',
    rebuildVideosAlbums: '重建 Videos + Albums',
    migrate: '迁移照片快捷方式',
    backfill: '回填共享权限',
    dedupe: '清除重复文件夹',
    dedupeDone: (folders: number, rows: number) => `已清除 ${folders} 个重复文件夹和 ${rows} 行过期记录。`,
    running: '执行中…',
    forbidden: '此页面仅限管理员，请使用管理员账号登录。',
    notEnabled: '服务器未启用托管文件夹（MANAGED_FOLDERS_ENABLED）。',
    done: '完成。',
    queued: '已加入队列——将在后台运行，关闭此页面也会继续。',
    progressHead: '重建进度',
    overall: (done: number, total: number) => `第 ${Math.min(done + 1, total)} / ${total} 步`,
    overallDone: '所有步骤已完成',
    batchProgress: (done: number, failed: number, total: number) =>
      `完成 ${done}，失败 ${failed}，共 ${total} 个活动`,
    batchDone: (done: number, failed: number, total: number) =>
      `已完成：重建 ${done}，失败 ${failed}（共 ${total} 个活动）。`,
    allEventsHint: '选择“全部活动”时，Photos / Videos + Albums / 迁移 将在后台运行。',
    managedAlbumsLink: '📑 打开公开相册索引表',
    managedAlbumsHint: '公开只读索引，列出所有 Photo / Video / Album 文件夹——每行均链接到原始 Google Drive 文件夹，可分享给参与者。',
    elapsed: (s: string) => `已用时 ${s}`,
    stepCount: '统计照片与视频数量',
    stepPhotos: '构建 Photos_NNN 文件夹',
    stepVideos: '构建 Videos 文件夹',
    stepAlbums: '构建 Album 文件夹',
    stepPublic: '更新公开相册索引表',
    counting: '统计中…',
    photosCount: (n: number) => `${n.toLocaleString()} 张照片`,
    foldersBuilt: (n: number) => `${n} 个文件夹`,
    scopesBuilt: (n: number) => `${n} 个文件夹`,
    rowsWritten: (n: number) => `已写入 ${n} 行`,
    stPending: '等待中',
    stRunning: '执行中…',
    stFailed: '失败',
    reconChecking: '正在统计…',
    reconSource: '源文件',
    reconFolders: 'Photos_NNN 中',
    reconVideos: 'Videos',
    reconIndexed: '已索引',
    reconFaces: (faces: number, photos: number) => `${faces} 张人脸 / ${photos} 张照片`,
    reconDupes: (n: number) => `${n} 张重复`,
    reconNoIndex: '尚未索引',
    reconRefresh: '刷新统计',
    reconNote: '已索引人脸少于照片数属于正常现象——只有可检测到人脸的照片才会被索引。',
    photosUnit: (n: number) => `${n.toLocaleString()} 张照片`,
    videosUnit: (n: number) => `${n} 个视频`,
  },
};

interface Reconcile {
  source: { photos: number; videos: number; media: number };
  folders: { photos: number; videos: number; albums: number };
  index: { status?: string | null; photos?: number | null; faces?: number | null; duplicates?: number | null } | null;
}

type StepKey = 'count' | 'photos' | 'videos' | 'albums' | 'public';
type StepStatus = 'pending' | 'running' | 'done' | 'failed';

interface StepProgress {
  key: StepKey;
  status: StepStatus;
  total?: number;
  done?: number;
  note?: string;
  error?: string;
}

interface RebuildBatch {
  id: string;
  kind: string;
  status: 'running' | 'done';
  total: number;
  done: string[];
  failed: Array<{ eventId: string; error: string }>;
  eventId?: string;
  steps?: StepProgress[];
  createdAt?: string;
  finishedAt?: string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Format an elapsed span (ms) as compact "mm:ss" / "h:mm:ss". */
function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Elapsed run time from the batch's createdAt to finishedAt (or now). Returns
 *  null if no start time is known. While running it ticks once a second so a
 *  long, otherwise-quiet rebuild visibly progresses. */
function useBatchElapsed(batch: RebuildBatch | null): string | null {
  const [, setTick] = useState(0);
  const running = batch != null && batch.status !== 'done';
  useEffect(() => {
    if (!running) return;
    const h = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(h);
  }, [running]);
  if (!batch?.createdAt) return null;
  const start = Date.parse(batch.createdAt);
  if (!Number.isFinite(start)) return null;
  const end = batch.finishedAt ? Date.parse(batch.finishedAt) : Date.now();
  return formatElapsed(end - start);
}

/**
 * Admin manual controls for the managed-folders pipeline (gas-app migration).
 *
 * Both single-event ("Rebuild this event", a stepped 'full' batch) and "All
 * events" rebuilds are enqueued server-side and run in bounded drain ticks, so
 * neither trips the 60s Hosting/Cloud Run timeout (the old single-event path
 * 502'd). While the user watches, the browser drives the drain itself (POST
 * /rebuild-drain, each call < 60s) for near-live progress; the Cloud Scheduler
 * drain is the backstop if they close the page. A 'full' batch reports per-step
 * progress (Photos_NNN → Videos → Album → public sheet) shown as a progress bar.
 */
export function AdminManagedFolders(): JSX.Element {
  const t = useStrings(STR);
  const [events, setEvents] = useState<EventSummary[] | null>(null);
  const [eventId, setEventId] = useState(''); // '' === all events
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [batch, setBatch] = useState<RebuildBatch | null>(null);
  const [albumsUrl, setAlbumsUrl] = useState<string | null>(null);
  const [recon, setRecon] = useState<Reconcile | null>(null);
  const [reconBusy, setReconBusy] = useState(false);
  // Bumped on unmount / new run so an in-flight drive loop knows to stop.
  const runToken = useRef(0);

  // Load the reconciliation counts for a single event (clears for "all events").
  // A live Drive walk, so only on demand: event change or after a rebuild.
  const loadRecon = useCallback(async (id: string): Promise<void> => {
    if (!id) {
      setRecon(null);
      return;
    }
    setReconBusy(true);
    try {
      const r = await apiGet<{ ok: true } & Reconcile>(`/api/admin/folders/reconcile/${encodeURIComponent(id)}`);
      setRecon({ source: r.source, folders: r.folders, index: r.index });
    } catch {
      setRecon(null);
    } finally {
      setReconBusy(false);
    }
  }, []);

  useEffect(() => {
    void loadRecon(eventId);
  }, [eventId, loadRecon]);

  useEffect(() => {
    apiGet<ListEventsResponse>('/api/events')
      .then((r) => setEvents([...r.events].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))))
      .catch((e) => {
        if (e instanceof ApiError && e.status === 403) setError(t.forbidden);
        else setEvents([]);
      });
  }, [t.forbidden]);

  // The world-readable Managed Albums index sheet, if configured. Best-effort —
  // the link is simply hidden when unset or unreachable.
  useEffect(() => {
    apiGet<{ ok: true; url: string | null }>('/api/managed-albums')
      .then((r) => setAlbumsUrl(r.url ?? null))
      .catch(() => setAlbumsUrl(null));
  }, []);

  // Stop any running drive loop when the page unmounts.
  useEffect(() => () => void (runToken.current += 1), []);

  const elapsed = useBatchElapsed(batch);

  /**
   * Drive a queued batch to completion: trigger a drain, read status, repeat.
   * Drain errors (e.g. a transient 502 on a very large step) are swallowed —
   * the lease-reclaim on the server resumes the step on the next tick.
   */
  const driveBatch = useCallback(
    async (batchId: string, token: number): Promise<void> => {
      const statusUrl = `/api/admin/folders/rebuild-status?batchId=${encodeURIComponent(batchId)}`;
      for (;;) {
        if (runToken.current !== token) return;
        try {
          await apiPost('/api/admin/folders/rebuild-drain', {});
        } catch {
          /* transient — the next drain (or the scheduler) picks it up */
        }
        if (runToken.current !== token) return;
        try {
          const r = await apiGet<{ ok: true; batch: RebuildBatch | null }>(statusUrl);
          if (r.batch) setBatch(r.batch);
          if (r.batch?.status === 'done') {
            setBusy(null);
            return;
          }
        } catch {
          /* transient — keep going */
        }
        await sleep(1500);
      }
    },
    [],
  );

  async function run(
    label: string,
    fn: () => Promise<unknown>,
    onDone?: (r: Record<string, unknown>) => string,
  ): Promise<void> {
    const token = (runToken.current += 1);
    setBusy(label);
    setMessage(null);
    setError(null);
    setBatch(null);
    try {
      const r = (await fn()) as { mode?: string; batchId?: string } & Record<string, unknown>;
      if (r?.mode === 'async' && r.batchId) {
        setMessage(t.queued);
        await driveBatch(r.batchId, token);
        if (runToken.current === token) void loadRecon(eventId);
        return;
      }
      setMessage(onDone ? onDone(r) : t.done);
      setBusy(null);
      void loadRecon(eventId);
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) setError(t.forbidden);
      else if (e instanceof ApiError && e.code === 'not_enabled') setError(t.notEnabled);
      else setError(e instanceof Error ? e.message : 'Error');
      setBusy(null);
    }
  }

  const body = (): { eventId?: string } => (eventId ? { eventId } : {});
  const disabled = busy !== null;
  const oneEvent = eventId !== '';

  return (
    <div>
      <h2>{t.title}</h2>
      <p className="muted">{t.intro}</p>

      {albumsUrl && (
        <p style={{ margin: '0 0 12px' }}>
          <a className="btn btn-light btn-sm" href={albumsUrl} target="_blank" rel="noopener noreferrer">
            {t.managedAlbumsLink}
          </a>
          <span className="muted" style={{ display: 'block', fontSize: '0.85em', marginTop: 4 }}>
            {t.managedAlbumsHint}
          </span>
        </p>
      )}

      <div className="feedback-filters">
        <label className="muted" style={{ marginRight: 8 }}>
          {t.eventLabel}:
        </label>
        <select
          className="feedback-input"
          value={eventId}
          onChange={(e) => setEventId(e.target.value)}
          aria-label={t.eventLabel}
          disabled={disabled || events === null}
          style={{ minWidth: 320 }}
        >
          <option value="">{events === null ? t.loadingEvents : t.allEvents}</option>
          {(events ?? []).map((ev) => (
            <option key={ev.id} value={ev.id}>
              {eventLabel({ name: ev.name, date: ev.date, id: ev.id, hasPhotos: true })}
              {ev.date ? ` (${ev.date})` : ''}
            </option>
          ))}
        </select>
      </div>
      <p className="muted" style={{ fontSize: '0.85em', marginTop: 4 }}>
        {t.allEventsHint}
      </p>

      <div className="event-meta" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
        <button
          className="btn btn-light btn-sm"
          disabled={disabled || !oneEvent}
          onClick={() => void run('one', () => apiPost(`/api/admin/folders/rebuild/${encodeURIComponent(eventId)}`, {}))}
        >
          {busy === 'one' ? t.running : t.rebuildOne}
        </button>
        <button className="btn btn-light btn-sm" disabled={disabled} onClick={() => void run('public', () => apiPost('/api/admin/folders/refresh-public', {}))}>
          {busy === 'public' ? t.running : t.refreshPublic}
        </button>
        <button className="btn btn-light btn-sm" disabled={disabled} onClick={() => void run('photos', () => apiPost('/api/admin/folders/rebuild-photos', body()))}>
          {busy === 'photos' ? t.running : t.rebuildPhotos}
        </button>
        <button className="btn btn-light btn-sm" disabled={disabled} onClick={() => void run('va', () => apiPost('/api/admin/folders/rebuild-videos-albums', body()))}>
          {busy === 'va' ? t.running : t.rebuildVideosAlbums}
        </button>
        <button className="btn btn-light btn-sm" disabled={disabled} onClick={() => void run('migrate', () => apiPost('/api/admin/folders/migrate-photo-shortcuts', body()))}>
          {busy === 'migrate' ? t.running : t.migrate}
        </button>
        <button className="btn btn-light btn-sm" disabled={disabled} onClick={() => void run('backfill', () => apiPost('/api/admin/folders/backfill-sharing', {}))}>
          {busy === 'backfill' ? t.running : t.backfill}
        </button>
        <button
          className="btn btn-light btn-sm"
          disabled={disabled || !oneEvent}
          onClick={() =>
            void run(
              'dedupe',
              () => apiPost(`/api/admin/folders/dedupe/${encodeURIComponent(eventId)}`, {}),
              (r) => t.dedupeDone(Number(r.trashedFolders ?? 0), Number(r.rowsRemoved ?? 0)),
            )
          }
        >
          {busy === 'dedupe' ? t.running : t.dedupe}
        </button>
      </div>

      {oneEvent && (recon || reconBusy) && (
        <div className="recon-line" role="status" aria-live="polite">
          {reconBusy && !recon ? (
            <span className="muted">{t.reconChecking}</span>
          ) : recon ? (
            <>
              <span>
                <strong>{t.reconSource}:</strong> {t.photosUnit(recon.source.photos)} · {t.videosUnit(recon.source.videos)}
              </span>
              <span className="recon-sep" aria-hidden="true">|</span>
              <span>
                <strong>{t.reconFolders}:</strong> {recon.folders.photos} · {t.reconVideos}: {recon.folders.videos}
              </span>
              <span className="recon-sep" aria-hidden="true">|</span>
              <span>
                <strong>{t.reconIndexed}:</strong>{' '}
                {recon.index && recon.index.faces != null && recon.index.photos != null ? (
                  <>
                    {t.reconFaces(recon.index.faces, recon.index.photos)}
                    {recon.index.duplicates ? ` · ${t.reconDupes(recon.index.duplicates)}` : ''}
                  </>
                ) : (
                  t.reconNoIndex
                )}
              </span>
              <button
                className="btn btn-light btn-sm"
                disabled={reconBusy || disabled}
                onClick={() => void loadRecon(eventId)}
              >
                {t.reconRefresh}
              </button>
            </>
          ) : null}
        </div>
      )}
      {oneEvent && recon && recon.folders.photos < recon.source.photos && (
        <p className="muted" style={{ fontSize: '0.85em', margin: '4px 0 0' }}>
          {t.reconNote}
        </p>
      )}

      {batch?.steps ? (
        <StepProgressView batch={batch} t={t} elapsed={elapsed} />
      ) : (
        batch && (
          <div className="rebuild-progress" role="status" aria-live="polite">
            <RebuildBar value={batch.done.length + batch.failed.length} max={batch.total} />
            <p className="muted" style={{ margin: '8px 0 0', display: 'flex', justifyContent: 'space-between', gap: 12 }}>
              <span>
                {batch.status === 'done'
                  ? t.batchDone(batch.done.length, batch.failed.length, batch.total)
                  : t.batchProgress(batch.done.length, batch.failed.length, batch.total)}
              </span>
              {elapsed && <span>{t.elapsed(elapsed)}</span>}
            </p>
          </div>
        )
      )}
      {error && <p className="error-text" style={{ marginTop: 12 }}>{error}</p>}
      {message && !batch && <p className="muted" style={{ marginTop: 12 }}>{message}</p>}
    </div>
  );
}

/** A slim determinate progress bar (completed / total). */
function RebuildBar({ value, max }: { value: number; max: number }): JSX.Element {
  const pct = max > 0 ? Math.round((Math.min(value, max) / max) * 100) : 0;
  return (
    <div className="rebuild-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <span className="rebuild-bar-fill" style={{ width: `${pct}%` }} />
    </div>
  );
}

/** Stepped progress for a single-event 'full' rebuild. */
function StepProgressView({
  batch,
  t,
  elapsed,
}: {
  batch: RebuildBatch;
  t: (typeof STR)['en'];
  elapsed: string | null;
}): JSX.Element {
  const steps = batch.steps ?? [];
  const completed = steps.filter((s) => s.status === 'done' || s.status === 'failed').length;

  const labelFor = (k: StepKey): string =>
    k === 'count'
      ? t.stepCount
      : k === 'photos'
        ? t.stepPhotos
        : k === 'videos'
          ? t.stepVideos
          : k === 'albums'
            ? t.stepAlbums
            : t.stepPublic;

  // Sub-line under each step. The count step surfaces photo/video totals up
  // front; the photos step then shows "<N photos> → <folders>" so the photo
  // denominator is visible from the first tick onward.
  const subFor = (s: StepProgress): string => {
    if (s.key === 'count') {
      if (s.status === 'done') return s.note ?? '';
      if (s.status === 'failed') return `${t.stFailed}: ${s.error ?? ''}`;
      return t.counting;
    }
    if (s.status === 'failed') return `${t.stFailed}: ${s.error ?? ''}`;
    if (s.key === 'photos') {
      const head = s.total != null ? t.photosCount(s.total) : '';
      if (s.status === 'done') return head ? `${head} → ${t.foldersBuilt(s.done ?? 0)}` : t.foldersBuilt(s.done ?? 0);
      if (s.status === 'running') return head ? `${head} → ${t.stRunning}` : t.stRunning;
      return head || t.stPending; // pending, denominator already known
    }
    if (s.key === 'public') {
      if (s.status === 'done') return s.done != null ? t.rowsWritten(s.done) : (s.note ?? '');
      return s.status === 'running' ? t.stRunning : t.stPending;
    }
    // videos / albums
    if (s.status === 'pending') return t.stPending;
    if (s.status === 'running') return t.stRunning;
    return s.done != null ? `${t.scopesBuilt(s.done)}${s.note ? ` · ${s.note}` : ''}` : (s.note ?? '');
  };

  return (
    <div className="rebuild-progress" role="status" aria-live="polite">
      <div className="rebuild-progress-head">
        <strong>{t.progressHead}</strong>
        <span className="muted">
          {batch.status === 'done' ? t.overallDone : t.overall(completed, steps.length)}
          {elapsed ? ` · ${t.elapsed(elapsed)}` : ''}
        </span>
      </div>
      <RebuildBar value={completed} max={steps.length} />
      <div style={{ marginTop: 10 }}>
        {steps.map((s) => (
          <div className="rebuild-step" key={s.key}>
            <span className={`step-badge step-${s.status}`} aria-hidden="true">
              {s.status === 'done' ? '✓' : s.status === 'failed' ? '✕' : s.status === 'running' ? <span className="step-spin" /> : '•'}
            </span>
            <span>
              <span className="step-label">{labelFor(s.key)}</span>
              <span className="step-sub">{subFor(s)}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
