import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { CreateEventResponse, EventSummary, ListEventsResponse } from '@cloud-webapp/shared';
import { apiGet, apiPost, ApiError } from '../lib/api.js';

/**
 * Events admin (dev plan G3.1/G3.3). Create an event (provisions a Drive folder
 * + Sheet row server-side) and jump to its upload-link management. Layout reuses
 * the responsive `feedback-filters` (wraps) + `table-wrap` (scrolls) classes so
 * it works on a phone.
 */
export function AdminEvents(): JSX.Element {
  const [events, setEvents] = useState<EventSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [busy, setBusy] = useState(false);

  const [name, setName] = useState('');
  const [date, setDate] = useState('');

  const load = useCallback(async () => {
    setError(null);
    setForbidden(false);
    try {
      const r = await apiGet<ListEventsResponse>('/api/events');
      setEvents([...r.events].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '')));
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) setForbidden(true);
      else setError(e instanceof Error ? e.message : 'Could not load events.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function create(): Promise<void> {
    if (!name.trim() || !date.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await apiPost<CreateEventResponse>('/api/admin/events', { name: name.trim(), date: date.trim() });
      setName('');
      setDate('');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create event.');
    } finally {
      setBusy(false);
    }
  }

  if (forbidden) {
    return (
      <div>
        <h2>Events</h2>
        <p className="muted">Event management is admin-only — sign in with an admin account.</p>
      </div>
    );
  }

  return (
    <div>
      <div className="gallery-header">
        <h2>Events</h2>
        <button className="btn btn-light btn-sm" onClick={() => void load()} disabled={busy}>
          Refresh
        </button>
      </div>

      <div className="feedback-filters">
        <input className="feedback-input" placeholder="Event name" value={name} onChange={(e) => setName(e.target.value)} />
        <input
          className="feedback-input"
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          aria-label="Event date"
        />
        <button className="btn btn-primary btn-sm" onClick={() => void create()} disabled={busy}>
          Create event
        </button>
      </div>

      {error && <p className="error-text">{error}</p>}

      {events === null ? (
        <p className="muted">Loading events…</p>
      ) : events.length === 0 ? (
        <p className="muted">No events yet.</p>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Date</th>
                <th>Index</th>
                <th>Links</th>
              </tr>
            </thead>
            <tbody>
              {events.map((ev) => (
                <tr key={ev.id}>
                  <td>{ev.name || ev.id}</td>
                  <td className="muted">{ev.date || '—'}</td>
                  <td className="muted">{ev.indexState?.status ?? '—'}</td>
                  <td>
                    <Link className="btn btn-light btn-sm" to={`/admin/events/${encodeURIComponent(ev.id)}/links`}>
                      Manage links
                    </Link>
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
