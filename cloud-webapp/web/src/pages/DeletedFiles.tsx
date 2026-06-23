import { useCallback, useEffect, useState } from 'react';
import type { DeletedFile, DeletedFileResponse, ListDeletedFilesResponse } from '@cloud-webapp/shared';
import { apiGet, apiPost, ApiError } from '../lib/api.js';

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
      else setError(e instanceof Error ? e.message : 'Could not load deleted files. · 无法加载已删除文件。');
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
      setError(e instanceof Error ? e.message : 'Restore failed. · 恢复失败。');
    } finally {
      setBusy(false);
    }
  }

  if (forbidden) {
    return (
      <div>
        <h2>Deleted files · 已删除文件</h2>
        <p className="muted">
          Deleted-file management is admin-only — sign in with an admin account. ·
          已删除文件管理仅限管理员，请使用管理员账号登录。
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="gallery-header">
        <h2>Deleted files · 已删除文件</h2>
        <button className="btn btn-light btn-sm" onClick={() => void load()} disabled={busy}>
          Refresh · 刷新
        </button>
      </div>

      <div className="feedback-filters">
        <select className="feedback-input" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status · 状态">
          {STATUS_FILTERS.map((s) => (
            <option key={s} value={s}>
              {s === '' ? 'All · 全部' : s}
            </option>
          ))}
        </select>
      </div>

      {error && <p className="error-text">{error}</p>}

      {files === null ? (
        <p className="muted">Loading… · 加载中…</p>
      ) : files.length === 0 ? (
        <p className="muted">No files for this filter. · 此筛选条件下暂无文件。</p>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>File · 文件</th>
                <th>Club · 俱乐部</th>
                <th>Deleted · 删除时间</th>
                <th>By · 操作者</th>
                <th>Status · 状态</th>
                <th>Actions · 操作</th>
              </tr>
            </thead>
            <tbody>
              {files.map((f) => (
                <tr key={f.deleteId}>
                  <td>{f.fileName || f.driveFileId}</td>
                  <td className="mono">{f.clubName || '—'}</td>
                  <td className="muted">{fmtWhen(f.deletedAt)}</td>
                  <td>{f.deletedBy || '—'}</td>
                  <td>
                    <span className={f.status === 'deleted' ? 'badge badge-err' : f.status === 'restored' ? 'badge badge-ok' : 'badge'}>
                      {f.status}
                    </span>
                  </td>
                  <td>
                    {f.status === 'deleted' ? (
                      <button className="btn btn-light btn-sm" onClick={() => void restore(f)} disabled={busy}>
                        Restore · 恢复
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
