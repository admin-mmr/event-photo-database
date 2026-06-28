import { useState } from 'react';
import { apiPost, ApiError } from '../lib/api.js';
import { useStrings } from '../lib/i18n.js';

const STR = {
  en: {
    title: 'Managed folders',
    intro:
      'Re-run the post-upload folder pipeline manually when the automatic run failed. These rebuild the Photos / Videos / Album folders and refresh the public folder index. Drive calls are throttled, so a full rebuild can take a while.',
    eventId: 'Event ID (optional — blank = all events)',
    refreshPublic: 'Refresh public index',
    rebuildOne: 'Rebuild this event',
    rebuildPhotos: 'Rebuild Photos (all)',
    rebuildVideosAlbums: 'Rebuild Videos + Albums (all)',
    migrate: 'Migrate photo shortcuts',
    backfill: 'Backfill sharing',
    running: 'Running…',
    forbidden: 'This page is admin-only — sign in with an admin account.',
    notEnabled: 'Managed folders are not enabled on the server (MANAGED_FOLDERS_ENABLED).',
    done: 'Done.',
  },
  zh: {
    title: '托管文件夹',
    intro:
      '当自动流程失败时，可在此手动重新运行上传后的文件夹处理：重建 Photos / Videos / Album 文件夹并刷新公开文件夹索引。Drive 调用已限速，完整重建可能需要一些时间。',
    eventId: '活动 ID（可选——留空表示全部活动）',
    refreshPublic: '刷新公开索引',
    rebuildOne: '重建此活动',
    rebuildPhotos: '重建 Photos（全部）',
    rebuildVideosAlbums: '重建 Videos + Albums（全部）',
    migrate: '迁移照片快捷方式',
    backfill: '回填共享权限',
    running: '执行中…',
    forbidden: '此页面仅限管理员，请使用管理员账号登录。',
    notEnabled: '服务器未启用托管文件夹（MANAGED_FOLDERS_ENABLED）。',
    done: '完成。',
  },
};

/**
 * Admin manual controls for the managed-folders pipeline (gas-app migration).
 * Buttons map 1:1 to /api/admin/folders/* so an admin can retrigger a failed
 * post-upload rebuild without redeploying or touching Drive by hand.
 */
export function AdminManagedFolders(): JSX.Element {
  const t = useStrings(STR);
  const [eventId, setEventId] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(label: string, fn: () => Promise<unknown>): Promise<void> {
    setBusy(label);
    setMessage(null);
    setError(null);
    try {
      const r = await fn();
      setMessage(`${t.done} ${JSON.stringify(r)}`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) setError(t.forbidden);
      else if (e instanceof ApiError && e.code === 'not_enabled') setError(t.notEnabled);
      else setError(e instanceof Error ? e.message : 'Error');
    } finally {
      setBusy(null);
    }
  }

  const body = (): { eventId?: string } => (eventId.trim() ? { eventId: eventId.trim() } : {});
  const disabled = busy !== null;

  return (
    <div>
      <h2>{t.title}</h2>
      <p className="muted">{t.intro}</p>

      <div className="feedback-filters">
        <input
          className="feedback-input"
          type="text"
          value={eventId}
          onChange={(e) => setEventId(e.target.value)}
          placeholder={t.eventId}
          aria-label={t.eventId}
          style={{ minWidth: 320 }}
        />
      </div>

      <div className="event-meta" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
        <button
          className="btn btn-light btn-sm"
          disabled={disabled || !eventId.trim()}
          onClick={() => void run('one', () => apiPost(`/api/admin/folders/rebuild/${encodeURIComponent(eventId.trim())}`, {}))}
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

      {error && <p className="error-text" style={{ marginTop: 12 }}>{error}</p>}
      {message && <pre className="mono" style={{ marginTop: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{message}</pre>}
    </div>
  );
}
