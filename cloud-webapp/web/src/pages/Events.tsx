import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ListEventsResponse, EventSummary, TriggerIndexResponse } from '@cloud-webapp/shared';
import { apiGet, apiPost, ApiError } from '../lib/api.js';
import { eventLabel } from '../lib/eventLabel.js';

/** Compact "x minutes ago" for the last-indexed timestamp. */
function timeAgo(iso?: string): string {
  if (!iso) return '';
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 45) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

interface StatusPill {
  label: string;
  className: string;
  inFlight: boolean;
}

function pillFor(ev: EventSummary): StatusPill {
  switch (ev.indexState?.status) {
    case 'done':
      return { label: 'Find Me ready', className: 'badge badge-ok', inFlight: false };
    case 'queued':
      return { label: 'Queued…', className: 'badge badge-warn', inFlight: true };
    case 'running':
      return { label: 'Indexing…', className: 'badge badge-warn', inFlight: true };
    case 'failed':
      return { label: 'Index failed', className: 'badge badge-err', inFlight: false };
    default:
      return { label: 'Not indexed', className: 'badge', inFlight: false };
  }
}

export function Events(): JSX.Element {
  const [events, setEvents] = useState<EventSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await apiGet<ListEventsResponse>('/api/events');
    setEvents(r.events);
  }, []);

  useEffect(() => {
    load().catch((e: Error) => setError(e.message));
  }, [load]);

  // Poll while any event is queued/running so the card reflects progress and
  // flips to "Find Me ready" automatically when the job finishes.
  const anyInFlight = (events ?? []).some((e) => pillFor(e).inFlight);
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    if (!anyInFlight) return;
    const t = setInterval(() => {
      loadRef.current().catch(() => undefined);
    }, 5000);
    return () => clearInterval(t);
  }, [anyInFlight]);

  async function indexNow(id: string): Promise<void> {
    setBusyId(id);
    setNotice(null);
    try {
      await apiPost<TriggerIndexResponse>(`/api/events/${id}/index`, {});
      // Optimistic: reflect "queued" immediately; polling takes over from here.
      setEvents((prev) =>
        (prev ?? []).map((e) =>
          e.id === id
            ? { ...e, indexState: { ...e.indexState, status: 'queued', updatedAt: new Date().toISOString() } }
            : e,
        ),
      );
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) {
        setNotice('Indexing is admin-only — sign in as an admin to run it.');
      } else if (e instanceof ApiError && e.status === 409) {
        setNotice('An index run is already in progress for that event.');
      } else {
        setNotice(e instanceof Error ? e.message : 'Could not start indexing.');
      }
    } finally {
      setBusyId(null);
    }
  }

  if (error) return <p className="error-text">Could not load events: {error}</p>;
  if (events === null) return <p className="muted">Loading events…</p>;

  return (
    <div>
      <h2>Events</h2>
      {notice && <p className="error-text">{notice}</p>}
      {events.length === 0 ? (
        <p className="muted">No events yet.</p>
      ) : (
        <ul className="event-list">
          {events.map((ev) => {
            const pill = pillFor(ev);
            const photoCount = ev.indexState?.photoCount;
            const updated = timeAgo(ev.indexState?.updatedAt);
            const hasName = Boolean(ev.name);
            const hasPhotos = (photoCount ?? 0) > 0;
            const label = eventLabel({ name: ev.name, date: ev.date, id: ev.id, hasPhotos });
            return (
              <li key={ev.id} className="event-card">
                <div className="event-row">
                  <Link to={`/events/${ev.id}`} className="event-link">
                    <span className="event-name">{label}</span>
                    {ev.date && <span className="event-date">{ev.date}</span>}
                    {!hasName && <span className="event-id muted">{ev.id}</span>}
                  </Link>
                  <div className="event-meta">
                    <span className={pill.className}>{pill.label}</span>
                    {typeof photoCount === 'number' && (
                      <span className="muted event-stat">{photoCount} photos</span>
                    )}
                    {updated && <span className="muted event-stat">updated {updated}</span>}
                    <button
                      className="btn btn-light btn-sm"
                      onClick={() => void indexNow(ev.id)}
                      disabled={busyId === ev.id || pill.inFlight}
                    >
                      {pill.inFlight ? 'Indexing…' : busyId === ev.id ? 'Starting…' : 'Index now'}
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
