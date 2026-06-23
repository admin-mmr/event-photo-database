import { useCallback, useEffect, useState } from 'react';
import type {
  ClubRecord,
  ListClubsResponse,
  ListUsersResponse,
  Role,
  UserRecord,
  UserResponse,
} from '@cloud-webapp/shared';
import { apiGet, apiPatch, apiPost, ApiError } from '../lib/api.js';

/**
 * Users admin (dev plan G2.2). CRUD over the Users tab (Sheet SSOT) via
 * /api/admin/users. Create/edit is super_admin only; a club_admin sees a
 * read-only, club-scoped list (the server enforces both). Non-admins get a
 * friendly forbidden state.
 */
export function AdminUsers(): JSX.Element {
  const [users, setUsers] = useState<UserRecord[] | null>(null);
  const [clubs, setClubs] = useState<ClubRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [busy, setBusy] = useState(false);

  const [email, setEmail] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [role, setRole] = useState<Role>('club_admin');
  const [clubId, setClubId] = useState('');

  const load = useCallback(async () => {
    setError(null);
    setForbidden(false);
    try {
      const r = await apiGet<ListUsersResponse>('/api/admin/users');
      setUsers(r.users);
      // Club list is best-effort (drives the dropdown); ignore its own 403.
      try {
        const c = await apiGet<ListClubsResponse>('/api/admin/clubs');
        setClubs(c.clubs.filter((x) => x.status === 'active'));
      } catch {
        /* non-fatal */
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) setForbidden(true);
      else setError(e instanceof Error ? e.message : 'Could not load users. · 无法加载用户。');
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
      setError(e instanceof Error ? e.message : 'Action failed. · 操作失败。');
    } finally {
      setBusy(false);
    }
  }

  async function create(): Promise<void> {
    if (!email.trim() || !firstName.trim() || !lastName.trim()) return;
    await act(async () => {
      await apiPost<UserResponse>('/api/admin/users', {
        email: email.trim(),
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        role,
        clubId: role === 'super_admin' ? undefined : clubId.trim(),
      });
      setEmail('');
      setFirstName('');
      setLastName('');
      setClubId('');
    });
  }

  async function changeRole(u: UserRecord): Promise<void> {
    const next = window.prompt(
      `Role for ${u.email} (super_admin / club_admin / api_client) · ${u.email} 的角色`,
      u.role,
    );
    if (next === null) return;
    const r = next.trim();
    if (r !== 'super_admin' && r !== 'club_admin' && r !== 'api_client') {
      setError('Invalid role. · 角色无效。');
      return;
    }
    const patch: { role: Role; clubId?: string } = { role: r };
    if (r !== 'super_admin') {
      const c = window.prompt(`Club id for ${u.email} · ${u.email} 的俱乐部 ID`, u.clubId) ?? '';
      patch.clubId = c.trim();
    }
    await act(() => apiPatch<UserResponse>(`/api/admin/users/${encodeURIComponent(u.email)}`, patch));
  }

  async function toggle(u: UserRecord): Promise<void> {
    const action = u.status === 'active' ? 'deactivate' : 'reactivate';
    await act(() => apiPost<UserResponse>(`/api/admin/users/${encodeURIComponent(u.email)}/${action}`, {}));
  }

  if (forbidden) {
    return (
      <div>
        <h2>Users · 用户</h2>
        <p className="muted">
          User management is admin-only — sign in with an admin account to view it. ·
          用户管理仅限管理员，请使用管理员账号登录查看。
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="gallery-header">
        <h2>Users · 用户</h2>
        <button className="btn btn-light btn-sm" onClick={() => void load()} disabled={busy}>
          Refresh · 刷新
        </button>
      </div>

      <div className="feedback-filters">
        <input className="feedback-input" placeholder="Email · 邮箱" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input className="feedback-input" placeholder="First name · 名" value={firstName} onChange={(e) => setFirstName(e.target.value)} />
        <input className="feedback-input" placeholder="Last name · 姓" value={lastName} onChange={(e) => setLastName(e.target.value)} />
        <select className="feedback-input" value={role} onChange={(e) => setRole(e.target.value as Role)} aria-label="Role · 角色">
          <option value="club_admin">club_admin</option>
          <option value="super_admin">super_admin</option>
          <option value="api_client">api_client</option>
        </select>
        {role !== 'super_admin' && (
          <select className="feedback-input" value={clubId} onChange={(e) => setClubId(e.target.value)} aria-label="Club · 俱乐部">
            <option value="">Select club… · 选择俱乐部…</option>
            {clubs.map((c) => (
              <option key={c.normalizedName} value={c.normalizedName}>
                {c.displayName}
              </option>
            ))}
          </select>
        )}
        <button className="btn btn-primary btn-sm" onClick={() => void create()} disabled={busy}>
          Add user · 添加用户
        </button>
      </div>

      {error && <p className="error-text">{error}</p>}

      {users === null ? (
        <p className="muted">Loading users… · 正在加载用户…</p>
      ) : users.length === 0 ? (
        <p className="muted">No users yet. · 暂无用户。</p>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Email · 邮箱</th>
                <th>Name · 姓名</th>
                <th>Role · 角色</th>
                <th>Club · 俱乐部</th>
                <th>Status · 状态</th>
                <th>Actions · 操作</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.email}>
                  <td className="mono">{u.email}</td>
                  <td>{`${u.firstName} ${u.lastName}`.trim() || '—'}</td>
                  <td>{u.role}</td>
                  <td className="mono">{u.clubId || '—'}</td>
                  <td>
                    <span className={u.status === 'active' ? 'badge badge-ok' : 'badge badge-err'}>{u.status}</span>
                  </td>
                  <td>
                    <button className="btn btn-light btn-sm" onClick={() => void changeRole(u)} disabled={busy}>
                      Edit role · 编辑角色
                    </button>{' '}
                    <button className="btn btn-light btn-sm" onClick={() => void toggle(u)} disabled={busy}>
                      {u.status === 'active' ? 'Deactivate · 停用' : 'Reactivate · 启用'}
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
