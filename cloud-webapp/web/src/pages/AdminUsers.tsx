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
      else setError(e instanceof Error ? e.message : 'Could not load users.');
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
      setError(e instanceof Error ? e.message : 'Action failed.');
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
    const next = window.prompt(`Role for ${u.email} (super_admin / club_admin / api_client)`, u.role);
    if (next === null) return;
    const r = next.trim();
    if (r !== 'super_admin' && r !== 'club_admin' && r !== 'api_client') {
      setError('Invalid role.');
      return;
    }
    const patch: { role: Role; clubId?: string } = { role: r };
    if (r !== 'super_admin') {
      const c = window.prompt(`Club id for ${u.email}`, u.clubId) ?? '';
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
        <h2>Users</h2>
        <p className="muted">User management is admin-only — sign in with an admin account to view it.</p>
      </div>
    );
  }

  return (
    <div>
      <div className="gallery-header">
        <h2>Users</h2>
        <button className="btn btn-light btn-sm" onClick={() => void load()} disabled={busy}>
          Refresh
        </button>
      </div>

      <div className="feedback-filters">
        <input className="feedback-input" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input className="feedback-input" placeholder="First name" value={firstName} onChange={(e) => setFirstName(e.target.value)} />
        <input className="feedback-input" placeholder="Last name" value={lastName} onChange={(e) => setLastName(e.target.value)} />
        <select className="feedback-input" value={role} onChange={(e) => setRole(e.target.value as Role)} aria-label="Role">
          <option value="club_admin">club_admin</option>
          <option value="super_admin">super_admin</option>
          <option value="api_client">api_client</option>
        </select>
        {role !== 'super_admin' && (
          <select className="feedback-input" value={clubId} onChange={(e) => setClubId(e.target.value)} aria-label="Club">
            <option value="">Select club…</option>
            {clubs.map((c) => (
              <option key={c.normalizedName} value={c.normalizedName}>
                {c.displayName}
              </option>
            ))}
          </select>
        )}
        <button className="btn btn-primary btn-sm" onClick={() => void create()} disabled={busy}>
          Add user
        </button>
      </div>

      {error && <p className="error-text">{error}</p>}

      {users === null ? (
        <p className="muted">Loading users…</p>
      ) : users.length === 0 ? (
        <p className="muted">No users yet.</p>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Name</th>
                <th>Role</th>
                <th>Club</th>
                <th>Status</th>
                <th>Actions</th>
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
                      Edit role
                    </button>{' '}
                    <button className="btn btn-light btn-sm" onClick={() => void toggle(u)} disabled={busy}>
                      {u.status === 'active' ? 'Deactivate' : 'Reactivate'}
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
