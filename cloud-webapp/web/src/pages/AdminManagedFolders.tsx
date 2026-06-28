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
    running: 'Running…',
    forbidden: 'This page is admin-only — sign in with an admin account.',
    notEnabled: 'Managed folders are not enabled on the server (MANAGED_FOLDERS_ENABLED).',
    done: 'Done.',
    queued: 'Queued for all events — this runs in the background and continues even if you close this page.',
    progress: (done: number, failed: number, total: number) =>
      `Progress: ${done} done, ${failed} failed, ${total} total.`,
    batchDone: (done: number, failed: number, total: number) =>
      `Finished: ${done} rebuilt, ${failed} failed (of ${total}).`,
    allEventsHint: 'For "All events", Photos / Videos + Albums / Migrate run in the background.',
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
    running: '执行中…',
    forbidden: '此页面仅限管理员，请使用管理员账号登录。',
    notEnabled: '服务器未启用托管文件夹（MANAGED_FOLDERS_ENABLED）。',
    done: '完成。',
    queued: '已为全部活动加入队列——将在后台运行，关闭此页面也会继续。',
    progress: (done: number, failed: number, total: number) =>
      `进度：完成 ${done}，失败 ${failed}，共 ${total}。`,
    batchDone: (done: number, failed: number, total: number) =>
      `已完成：重建 ${done}，失败 ${failed}（共 ${total}）。`,
    allEventsHint: '选择“全部活动”时，Photos / Videos + Albums / 迁移 将在后台运行。',
  },
};

interface RebuildBatch {
  id: string;
  status: 'running' | 'done';
  total: number;
  done: string[];
  failed: Array<{ eventId: string; error: string }>;
}

/**
 * Admin manual controls for the managed-folders pipeline (gas-app migration).
 * Single-event rebuilds run synchronously; "All events" rebuilds are enqueued
 * server-side and drained by the scheduler (folderRebuildQueue.ts), so they no
 * longer trip the 60s Hosting/Cloud Run timeout. An event dropdown replaces the
 * old free-text Event ID box.
 */
export function AdminManagedFolders(): JSX.Element {
  const t = useStrings(STR);
  const [events, setEvents] = useState<EventSummary[] | null>(null);
  const [eventId, setEventId] = useState(''); // '' === all events
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [batch, setBatch] = useState<RebuildBatch | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    apiGet<ListEventsResponse>('/api/events')
      .then((r) => setEvents([...r.events].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))))
      .catch((e) => {
        if (e instanceof ApiError && e.status === 403) setError(t.forbidden);
        else setEvents([]);
      });
  }, [t.forbidden]);

  const stopPolling = useCallback(() => {
    if (pollTimer.current) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  const pollBatch = useCallback(
    (batchId: string) => {
      stopPolling();
      pollTimer.current = setInterval(() => {
        void apiGet<{ ok: true; batch: RebuildBatch | null }>(
          `/api/admin/folders/rebuild-status?batchId=${encodeURIComponent(batchId)}`,
        )
          .then((r) => {
            if (!r.batch) return;
            setBatch(r.batch);
            if (r.batch.status === 'done') {
              stopPolling();
              setBusy(null);
            }
          })
          .catch(() => {
            /* transient — keep polling */
          });
      }, 4000);
    },
    [stopPolling],
  );

  async function run(label: string, fn: () => Promise<unknown>): Promise<void> {
    setBusy(label);
    setMessage(null);
    setError(null);
    setBatch(null);
    stopPolling();
    try {
      const r = (await fn()) as { mode?: string; batchId?: string };
      if (r?.mode === 'async' && r.batchId) {
        setMessage(t.queued);
        pollBatch(r.batchId);
        return; // busy stays set until the batch finishes
      }
      setMessage(t.done);
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) setError(t.forbidden);
      else if (e instanceof ApiError && e.code === 'not_enabled') setError(t.notEnabled);
      else setError(e instanceof Error ? e.message : 'Error');
    } finally {
      if (!pollTimer.current) setBusy(null);
    }
  }

  const body = (): { eventId?: string } => (eventId ? { eventId } : {});
  const disabled = busy !== null;
  const oneEvent = eventId !== '';

  return (
    <div>
      <h2>{t.title}</h2>
      <p className="muted">{t.intro}</p>

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
      </div>

      {batch && (
        <p className="muted" style={{ marginTop: 12 }}>
          {batch.status === 'done'
            ? t.batchDone(batch.done.length, batch.failed.length, batch.total)
            : t.progress(batch.done.length, batch.failed.length, batch.total)}
        </p>
      )}
      {error && <p className="error-text" style={{ marginTop: 12 }}>{error}</p>}
      {message && !batch && <p className="muted" style={{ marginTop: 12 }}>{message}</p>}
    </div>
  );
}
