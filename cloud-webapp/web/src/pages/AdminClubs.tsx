import { useCallback, useEffect, useState } from 'react';
import type { ClubRecord, ListClubsResponse, ClubResponse } from '@cloud-webapp/shared';
import { apiGet, apiPatch, apiPost, ApiError } from '../lib/api.js';
import { useStrings } from '../lib/i18n.js';

const STR = {
  en: {
    couldNotLoad: 'Could not load clubs.',
    actionFailed: 'Action failed.',
    renamePrompt: (id: string) => `New display name for ${id}`,
    forbiddenTitle: 'Clubs',
    forbiddenBody:
      'Club management is admin-only — sign in with an admin account to view it.',
    title: 'Clubs',
    refresh: 'Refresh',
    phDisplayName: 'Display name (e.g. New York Runners)',
    phId: 'ID (e.g. New_York)',
    normalizedIdLabel: 'Normalized club id',
    addClub: 'Add club',
    loading: 'Loading clubs…',
    noClubs: 'No clubs yet.',
    colDisplayName: 'Display name',
    colId: 'ID',
    colStatus: 'Status',
    colActions: 'Actions',
    rename: 'Rename',
    deactivate: 'Deactivate',
    reactivate: 'Reactivate',
  },
  zh: {
    couldNotLoad: '无法加载俱乐部。',
    actionFailed: '操作失败。',
    renamePrompt: (id: string) => `${id} 的新显示名称`,
    forbiddenTitle: '俱乐部',
    forbiddenBody: '俱乐部管理仅限管理员，请使用管理员账号登录查看。',
    title: '俱乐部',
    refresh: '刷新',
    phDisplayName: '显示名称（例如 New York Runners）',
    phId: 'ID（例如 New_York）',
    normalizedIdLabel: '俱乐部 ID',
    addClub: '添加俱乐部',
    loading: '正在加载俱乐部…',
    noClubs: '暂无俱乐部。',
    colDisplayName: '显示名称',
    colId: 'ID',
    colStatus: '状态',
    colActions: '操作',
    rename: '重命名',
    deactivate: '停用',
    reactivate: '启用',
  },
};

/**
 * Clubs admin (dev plan G2.2). CRUD over the Clubs tab (Sheet SSOT) via
 * /api/admin/clubs. Server-authoritative: a non-admin gets 403, surfaced as a
 * friendly empty state (mirrors FeedbackAdmin). Create/edit is super_admin only;
 * a club_admin sees a read-only list.
 */
export function AdminClubs(): JSX.Element {
  const t = useStrings(STR);
  const [clubs, setClubs] = useState<ClubRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [busy, setBusy] = useState(false);

  const [displayName, setDisplayName] = useState('');
  const [normalizedName, setNormalizedName] = useState('');

  const load = useCallback(async () => {
    setError(null);
    setForbidden(false);
    try {
      const r = await apiGet<ListClubsResponse>('/api/admin/clubs');
      setClubs(r.clubs);
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) setForbidden(true);
      else setError(e instanceof Error ? e.message : t.couldNotLoad);
    }
  }, []);

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
      setError(e instanceof Error ? e.message : t.actionFailed);
    } finally {
      setBusy(false);
    }
  }

  async function create(): Promise<void> {
    if (!displayName.trim() || !normalizedName.trim()) return;
    await act(async () => {
      await apiPost<ClubResponse>('/api/admin/clubs', {
        displayName: displayName.trim(),
        normalizedName: normalizedName.trim(),
      });
      setDisplayName('');
      setNormalizedName('');
    });
  }

  async function rename(c: ClubRecord): Promise<void> {
    const next = window.prompt(t.renamePrompt(c.normalizedName), c.displayName);
    if (next === null || !next.trim() || next.trim() === c.displayName) return;
    await act(() => apiPatch<ClubResponse>(`/api/admin/clubs/${encodeURIComponent(c.normalizedName)}`, { displayName: next.trim() }));
  }

  async function toggle(c: ClubRecord): Promise<void> {
    const action = c.status === 'active' ? 'deactivate' : 'reactivate';
    await act(() => apiPost<ClubResponse>(`/api/admin/clubs/${encodeURIComponent(c.normalizedName)}/${action}`, {}));
  }

  if (forbidden) {
    return (
      <div>
        <h2>{t.forbiddenTitle}</h2>
        <p className="muted">{t.forbiddenBody}</p>
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
        <input
          className="feedback-input"
          placeholder={t.phDisplayName}
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
        />
        <input
          className="feedback-input"
          placeholder={t.phId}
          value={normalizedName}
          onChange={(e) => setNormalizedName(e.target.value)}
          aria-label={t.normalizedIdLabel}
        />
        <button className="btn btn-primary btn-sm" onClick={() => void create()} disabled={busy}>
          {t.addClub}
        </button>
      </div>

      {error && <p className="error-text">{error}</p>}

      {clubs === null ? (
        <p className="muted">{t.loading}</p>
      ) : clubs.length === 0 ? (
        <p className="muted">{t.noClubs}</p>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>{t.colDisplayName}</th>
                <th>{t.colId}</th>
                <th>{t.colStatus}</th>
                <th>{t.colActions}</th>
              </tr>
            </thead>
            <tbody>
              {clubs.map((c) => (
                <tr key={c.normalizedName}>
                  <td data-label={t.colDisplayName}>{c.displayName}</td>
                  <td className="mono" data-label={t.colId}>{c.normalizedName}</td>
                  <td data-label={t.colStatus}>
                    <span className={c.status === 'active' ? 'badge badge-ok' : 'badge badge-err'}>{c.status}</span>
                  </td>
                  <td data-label={t.colActions}>
                    <button className="btn btn-light btn-sm" onClick={() => void rename(c)} disabled={busy}>
                      {t.rename}
                    </button>{' '}
                    <button className="btn btn-light btn-sm" onClick={() => void toggle(c)} disabled={busy}>
                      {c.status === 'active' ? t.deactivate : t.reactivate}
                    </button>
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
