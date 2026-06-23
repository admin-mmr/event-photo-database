import { useCallback, useEffect, useState } from 'react';
import { Link as RouterLink, useParams } from 'react-router-dom';
import type {
  ClubRecord,
  LinkRecord,
  LinkResponse,
  ListClubsResponse,
  ListLinksResponse,
} from '@cloud-webapp/shared';
import { apiGet, apiPost, ApiError } from '../lib/api.js';

/** Build the public volunteer-upload URL from a link token. */
function uploadUrl(token: string): string {
  return `${window.location.origin}/upload/${token}`;
}

/**
 * Upload-link management for one event (dev plan G3.2/G3.3). Generate / revoke /
 * rotate volunteer links; copy the shareable URL. Club_admins are scoped to
 * their own club server-side. Mobile-friendly via the wrapping/scrolling classes.
 */
export function AdminLinks(): JSX.Element {
  const { eventId = '' } = useParams();
  const [links, setLinks] = useState<LinkRecord[] | null>(null);
  const [clubs, setClubs] = useState<ClubRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const [clubName, setClubName] = useState('');
  const [tag, setTag] = useState('');

  const load = useCallback(async () => {
    setError(null);
    setForbidden(false);
    try {
      const r = await apiGet<ListLinksResponse>(`/api/admin/links?eventId=${encodeURIComponent(eventId)}`);
      setLinks(r.links);
      try {
        const c = await apiGet<ListClubsResponse>('/api/admin/clubs');
        setClubs(c.clubs.filter((x) => x.status === 'active'));
      } catch {
        /* non-fatal */
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) setForbidden(true);
      else setError(e instanceof Error ? e.message : 'Could not load links. · 无法加载链接。');
    }
  }, [eventId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(fn: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed. · 操作失败。');
    } finally {
      setBusy(false);
    }
  }

  async function generate(): Promise<void> {
    if (!clubName.trim()) return;
    await act(async () => {
      await apiPost<LinkResponse>('/api/admin/links', {
        eventId,
        clubName: clubName.trim(),
        tag: tag.trim() || undefined,
      });
      setTag('');
    });
  }

  async function copy(token: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(uploadUrl(token));
      setCopied(token);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      setError('Could not copy to clipboard. · 无法复制到剪贴板。');
    }
  }

  if (forbidden) {
    return (
      <div>
        <h2>Upload links · 上传链接</h2>
        <p className="muted">
          Link management is admin-only — sign in with an admin account. ·
          链接管理仅限管理员，请使用管理员账号登录。
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="gallery-header">
        <h2>Upload links · 上传链接</h2>
        <RouterLink to="/admin/events" className="muted nav-link">
          ← All events · 全部活动
        </RouterLink>
      </div>
      <p className="muted">
        Event · 活动 <span className="mono">{eventId}</span>
      </p>

      <div className="feedback-filters">
        {clubs.length > 0 ? (
          <select className="feedback-input" value={clubName} onChange={(e) => setClubName(e.target.value)} aria-label="Club · 俱乐部">
            <option value="">Select club… · 选择俱乐部…</option>
            {clubs.map((c) => (
              <option key={c.normalizedName} value={c.normalizedName}>
                {c.displayName}
              </option>
            ))}
          </select>
        ) : (
          <input className="feedback-input" placeholder="Club id · 俱乐部 ID" value={clubName} onChange={(e) => setClubName(e.target.value)} />
        )}
        <input
          className="feedback-input"
          placeholder="Tag (optional, e.g. finish_line) · 标签（可选，例如 finish_line）"
          value={tag}
          onChange={(e) => setTag(e.target.value)}
        />
        <button className="btn btn-primary btn-sm" onClick={() => void generate()} disabled={busy}>
          Generate link · 生成链接
        </button>
      </div>

      {error && <p className="error-text">{error}</p>}

      {links === null ? (
        <p className="muted">Loading links… · 正在加载链接…</p>
      ) : links.length === 0 ? (
        <p className="muted">No links yet for this event. · 本次活动暂无链接。</p>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Club · 俱乐部</th>
                <th>Tag · 标签</th>
                <th>Ver · 版本</th>
                <th>Status · 状态</th>
                <th>Link · 链接</th>
                <th>Actions · 操作</th>
              </tr>
            </thead>
            <tbody>
              {links.map((l) => (
                <tr key={l.linkId}>
                  <td className="mono">{l.clubName}</td>
                  <td>{l.tag}</td>
                  <td className="muted">{l.version}</td>
                  <td>
                    <span className={l.status === 'active' ? 'badge badge-ok' : 'badge badge-err'}>{l.status}</span>
                  </td>
                  <td>
                    {l.status === 'active' ? (
                      <button className="btn btn-light btn-sm" onClick={() => void copy(l.token)} disabled={busy}>
                        {copied === l.token ? 'Copied! · 已复制！' : 'Copy URL · 复制链接'}
                      </button>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td>
                    {l.status === 'active' && (
                      <>
                        <button className="btn btn-light btn-sm" onClick={() => void act(() => apiPost<LinkResponse>(`/api/admin/links/${encodeURIComponent(l.linkId)}/rotate`, {}))} disabled={busy}>
                          Rotate · 轮换
                        </button>{' '}
                        <button className="btn btn-light btn-sm" onClick={() => void act(() => apiPost<LinkResponse>(`/api/admin/links/${encodeURIComponent(l.linkId)}/revoke`, {}))} disabled={busy}>
                          Revoke · 吊销
                        </button>
                      </>
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
