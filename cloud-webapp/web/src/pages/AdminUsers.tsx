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
import { useStrings } from '../lib/i18n.js';

const STR = {
  en: {
    couldNotLoad: 'Could not load users.',
    actionFailed: 'Action failed.',
    rolePrompt: (email: string) =>
      `Role for ${email} (super_admin / club_admin / api_client)`,
    invalidRole: 'Invalid role.',
    clubIdPrompt: (email: string) => `Club id for ${email}`,
    forbiddenTitle: 'Users',
    forbiddenBody:
      'User management is admin-only — sign in with an admin account to view it.',
    title: 'Users',
    refresh: 'Refresh',
    phEmail: 'Email',
    phFirstName: 'First name',
    phLastName: 'Last name',
    roleLabel: 'Role',
    clubLabel: 'Club',
    selectClub: 'Select club…',
    addUser: 'Add user',
    loading: 'Loading users…',
    noUsers: 'No users yet.',
    colEmail: 'Email',
    colName: 'Name',
    colRole: 'Role',
    colClub: 'Club',
    colStatus: 'Status',
    colActions: 'Actions',
    editRole: 'Edit role',
    deactivate: 'Deactivate',
    reactivate: 'Reactivate',
  },
  zh: {
    couldNotLoad: '无法加载用户。',
    actionFailed: '操作失败。',
    rolePrompt: (email: string) => `${email} 的角色`,
    invalidRole: '角色无效。',
    clubIdPrompt: (email: string) => `${email} 的俱乐部 ID`,
    forbiddenTitle: '用户',
    forbiddenBody: '用户管理仅限管理员，请使用管理员账号登录查看。',
    title: '用户',
    refresh: '刷新',
    phEmail: '邮箱',
    phFirstName: '名',
    phLastName: '姓',
    roleLabel: '角色',
    clubLabel: '俱乐部',
    selectClub: '选择俱乐部…',
    addUser: '添加用户',
    loading: '正在加载用户…',
    noUsers: '暂无用户。',
    colEmail: '邮箱',
    colName: '姓名',
    colRole: '角色',
    colClub: '俱乐部',
    colStatus: '状态',
    colActions: '操作',
    editRole: '编辑角色',
    deactivate: '停用',
    reactivate: '启用',
  },
};

/**
 * Users admin (dev plan G2.2). CRUD over the Users tab (Sheet SSOT) via
 * /api/admin/users. Create/edit is super_admin only; a club_admin sees a
 * read-only, club-scoped list (the server enforces both). Non-admins get a
 * friendly forbidden state.
 */
export function AdminUsers(): JSX.Element {
  const t = useStrings(STR);
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
    const next = window.prompt(t.rolePrompt(u.email), u.role);
    if (next === null) return;
    const r = next.trim();
    if (r !== 'super_admin' && r !== 'club_admin' && r !== 'api_client') {
      setError(t.invalidRole);
      return;
    }
    const patch: { role: Role; clubId?: string } = { role: r };
    if (r !== 'super_admin') {
      const c = window.prompt(t.clubIdPrompt(u.email), u.clubId) ?? '';
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
        <input className="feedback-input" placeholder={t.phEmail} value={email} onChange={(e) => setEmail(e.target.value)} />
        <input className="feedback-input" placeholder={t.phFirstName} value={firstName} onChange={(e) => setFirstName(e.target.value)} />
        <input className="feedback-input" placeholder={t.phLastName} value={lastName} onChange={(e) => setLastName(e.target.value)} />
        <select className="feedback-input" value={role} onChange={(e) => setRole(e.target.value as Role)} aria-label={t.roleLabel}>
          <option value="club_admin">club_admin</option>
          <option value="super_admin">super_admin</option>
          <option value="api_client">api_client</option>
        </select>
        {role !== 'super_admin' && (
          <select className="feedback-input" value={clubId} onChange={(e) => setClubId(e.target.value)} aria-label={t.clubLabel}>
            <option value="">{t.selectClub}</option>
            {clubs.map((c) => (
              <option key={c.normalizedName} value={c.normalizedName}>
                {c.displayName}
              </option>
            ))}
          </select>
        )}
        <button className="btn btn-primary btn-sm" onClick={() => void create()} disabled={busy}>
          {t.addUser}
        </button>
      </div>

      {error && <p className="error-text">{error}</p>}

      {users === null ? (
        <p className="muted">{t.loading}</p>
      ) : users.length === 0 ? (
        <p className="muted">{t.noUsers}</p>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>{t.colEmail}</th>
                <th>{t.colName}</th>
                <th>{t.colRole}</th>
                <th>{t.colClub}</th>
                <th>{t.colStatus}</th>
                <th>{t.colActions}</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.email}>
                  <td className="mono" data-label={t.colEmail}>{u.email}</td>
                  <td data-label={t.colName}>{`${u.firstName} ${u.lastName}`.trim() || '—'}</td>
                  <td data-label={t.colRole}>{u.role}</td>
                  <td className="mono" data-label={t.colClub}>{u.clubId || '—'}</td>
                  <td data-label={t.colStatus}>
                    <span className={u.status === 'active' ? 'badge badge-ok' : 'badge badge-err'}>{u.status}</span>
                  </td>
                  <td data-label={t.colActions}>
                    <button className="btn btn-light btn-sm" onClick={() => void changeRole(u)} disabled={busy}>
                      {t.editRole}
                    </button>{' '}
                    <button className="btn btn-light btn-sm" onClick={() => void toggle(u)} disabled={busy}>
                      {u.status === 'active' ? t.deactivate : t.reactivate}
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
