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
      else setError(e instanceof Error ? e.message : 'Could not load links.');
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
      setError(e instanceof Error ? e.message : 'Action failed.');
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
      setError('Could not copy to clipboard.');
    }
  }

  if (forbidden) {
    return (
      <div>
        <h2>Upload links</h2>
        <p className="muted">Link management is admin-only — sign in with an admin account.</p>
      </div>
    );
  }

  return (
    <div>
      <div className="gallery-header">
        <h2>Upload links</h2>
        <RouterLink to="/admin/events" className="muted nav-link">
          ← All events
        </RouterLink>
      </div>
      <p className="muted">
        Event <span className="mono">{eventId}</span>
      </p>

      <div className="feedback-filters">
        {clubs.length > 0 ? (
          <select className="feedback-input" value={clubName} onChange={(e) => setClubName(e.target.value)} aria-label="Club">
            <option value="">Select club…</option>
            {clubs.map((c) => (
              <option key={c.normalizedName} value={c.normalizedName}>
                {c.displayName}
              </option>
            ))}
          </select>
        ) : (
          <input className="feedback-input" placeholder="Club id" value={clubName} onChange={(e) => setClubName(e.target.value)} />
        )}
        <input
          className="feedback-input"
          placeholder="Tag (optional, e.g. finish_line)"
          value={tag}
          onChange={(e) => setTag(e.target.value)}
        />
        <button className="btn btn-primary btn-sm" onClick={() => void generate()} disabled={busy}>
          Generate link
        </button>
      </div>

      {error && <p className="error-text">{error}</p>}

      {links === null ? (
        <p className="muted">Loading links…</p>
      ) : links.length === 0 ? (
        <p className="muted">No links yet for this event.</p>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Club</th>
                <th>Tag</th>
                <th>Ver</th>
                <th>Status</th>
                <th>Link</th>
                <th>Actions</th>
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
                        {copied === l.token ? 'Copied!' : 'Copy URL'}
                      </button>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td>
                    {l.status === 'active' && (
                      <>
                        <button className="btn btn-light btn-sm" onClick={() => void act(() => apiPost<LinkResponse>(`/api/admin/links/${encodeURIComponent(l.linkId)}/rotate`, {}))} disabled={busy}>
                          Rotate
                        </button>{' '}
                        <button className="btn btn-light btn-sm" onClick={() => void act(() => apiPost<LinkResponse>(`/api/admin/links/${encodeURIComponent(l.linkId)}/revoke`, {}))} disabled={busy}>
                          Revoke
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
