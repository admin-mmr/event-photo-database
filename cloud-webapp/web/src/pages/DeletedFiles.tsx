import { useCallback, useEffect, useState } from 'react';
import type { DeletedFile, DeletedFileResponse, ListDeletedFilesResponse } from '@cloud-webapp/shared';
import { apiGet, apiPost, ApiError } from '../lib/api.js';
import { useStrings } from '../lib/i18n.js';

const STR = {
  en: {
    title: 'Deleted files',
    forbidden: 'Deleted-file management is admin-only — sign in with an admin account.',
    loadError: 'Could not load deleted files.',
    restoreFailed: 'Restore failed.',
    refresh: 'Refresh',
    statusLabel: 'Status',
    all: 'All',
    loading: 'Loading…',
    noFiles: 'No files for this filter.',
    file: 'File',
    club: 'Club',
    deleted: 'Deleted',
    by: 'By',
    status: 'Status',
    actions: 'Actions',
    restore: 'Restore',
  },
  zh: {
    title: '已删除文件',
    forbidden: '已删除文件管理仅限管理员，请使用管理员账号登录。',
    loadError: '无法加载已删除文件。',
    restoreFailed: '恢复失败。',
    refresh: '刷新',
    statusLabel: '状态',
    all: '全部',
    loading: '加载中…',
    noFiles: '此筛选条件下暂无文件。',
    file: '文件',
    club: '俱乐部',
    deleted: '删除时间',
    by: '操作者',
    status: '状态',
    actions: '操作',
    restore: '恢复',
  },
};

function fmtWhen(iso: string): string {
  const t = Date.parse(iso);
  return Number.isFinite(t)
    ? new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : iso || '—';
}

const STATUS_FILTERS = ['', 'deleted', 'restored', 'purged'] as const;

/**
 * Deleted-files (trash) management (dev plan G5.1). Lists soft-deleted files and
 * restores them within the retention window. Club-scoped server-side; permanent
 * purge happens via the scheduled job, not here. Mobile-friendly.
 */
export function DeletedFiles(): JSX.Element {
  const t = useStrings(STR);
  const [files, setFiles] = useState<DeletedFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string>('deleted');

  const load = useCallback(async () => {
    setError(null);
    setForbidden(false);
    const qs = new URLSearchParams();
    if (status) qs.set('status', status);
    try {
      const r = await apiGet<ListDeletedFilesResponse>(`/api/admin/deleted-files?${qs.toString()}`);
      setFiles(r.files);
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) setForbidden(true);
      else setError(e instanceof Error ? e.message : t.loadError);
    }
  }, [status]);

  useEffect(() => {
    void load();
  }, [load]);

  async function restore(f: DeletedFile): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await apiPost<DeletedFileResponse>(`/api/admin/deleted-files/${encodeURIComponent(f.deleteId)}/restore`, {});
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t.restoreFailed);
    } finally {
      setBusy(false);
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

  return (
    <div>
      <div className="gallery-header">
        <h2>{t.title}</h2>
        <button className="btn btn-light btn-sm" onClick={() => void load()} disabled={busy}>
          {t.refresh}
        </button>
      </div>

      <div className="feedback-filters">
        <select className="feedback-input" value={status} onChange={(e) => setStatus(e.target.value)} aria-label={t.statusLabel}>
          {STATUS_FILTERS.map((s) => (
            <option key={s} value={s}>
              {s === '' ? t.all : s}
            </option>
          ))}
        </select>
      </div>

      {error && <p className="error-text">{error}</p>}

      {files === null ? (
        <p className="muted">{t.loading}</p>
      ) : files.length === 0 ? (
        <p className="muted">{t.noFiles}</p>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>{t.file}</th>
                <th>{t.club}</th>
                <th>{t.deleted}</th>
                <th>{t.by}</th>
                <th>{t.status}</th>
                <th>{t.actions}</th>
              </tr>
            </thead>
            <tbody>
              {files.map((f) => (
                <tr key={f.deleteId}>
                  <td data-label={t.file}>{f.fileName || f.driveFileId}</td>
                  <td className="mono" data-label={t.club}>{f.clubName || '—'}</td>
                  <td className="muted" data-label={t.deleted}>{fmtWhen(f.deletedAt)}</td>
                  <td data-label={t.by}>{f.deletedBy || '—'}</td>
                  <td data-label={t.status}>
                    <span className={f.status === 'deleted' ? 'badge badge-err' : f.status === 'restored' ? 'badge badge-ok' : 'badge'}>
                      {f.status}
                    </span>
                  </td>
                  <td data-label={t.actions}>
                    {f.status === 'deleted' ? (
                      <button className="btn btn-light btn-sm" onClick={() => void restore(f)} disabled={busy}>
                        {t.restore}
                      </button>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
