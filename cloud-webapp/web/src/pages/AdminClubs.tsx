import { useCallback, useEffect, useState } from 'react';
import type { ClubRecord, ListClubsResponse, ClubResponse } from '@cloud-webapp/shared';
import { apiGet, apiPatch, apiPost, ApiError } from '../lib/api.js';

/**
 * Clubs admin (dev plan G2.2). CRUD over the Clubs tab (Sheet SSOT) via
 * /api/admin/clubs. Server-authoritative: a non-admin gets 403, surfaced as a
 * friendly empty state (mirrors FeedbackAdmin). Create/edit is super_admin only;
 * a club_admin sees a read-only list.
 */
export function AdminClubs(): JSX.Element {
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
      else setError(e instanceof Error ? e.message : 'Could not load clubs.');
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
    const next = window.prompt(`New display name for ${c.normalizedName}`, c.displayName);
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
        <h2>Clubs</h2>
        <p className="muted">Club management is admin-only — sign in with an admin account to view it.</p>
      </div>
    );
  }

  return (
    <div>
      <div className="gallery-header">
        <h2>Clubs</h2>
        <button className="btn btn-light btn-sm" onClick={() => void load()} disabled={busy}>
          Refresh
        </button>
      </div>

      <div className="feedback-filters">
        <input
          className="feedback-input"
          placeholder="Display name (e.g. New York Runners)"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
        />
        <input
          className="feedback-input"
          placeholder="ID (e.g. New_York)"
          value={normalizedName}
          onChange={(e) => setNormalizedName(e.target.value)}
          aria-label="Normalized club id"
        />
        <button className="btn btn-primary btn-sm" onClick={() => void create()} disabled={busy}>
          Add club
        </button>
      </div>

      {error && <p className="error-text">{error}</p>}

      {clubs === null ? (
        <p className="muted">Loading clubs…</p>
      ) : clubs.length === 0 ? (
        <p className="muted">No clubs yet.</p>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Display name</th>
                <th>ID</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {clubs.map((c) => (
                <tr key={c.normalizedName}>
                  <td>{c.displayName}</td>
                  <td className="mono">{c.normalizedName}</td>
                  <td>
                    <span className={c.status === 'active' ? 'badge badge-ok' : 'badge badge-err'}>{c.status}</span>
                  </td>
                  <td>
                    <button className="btn btn-light btn-sm" onClick={() => void rename(c)} disabled={busy}>
                      Rename
                    </button>{' '}
                    <button className="btn btn-light btn-sm" onClick={() => void toggle(c)} disabled={busy}>
                      {c.status === 'active' ? 'Deactivate' : 'Reactivate'}
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
