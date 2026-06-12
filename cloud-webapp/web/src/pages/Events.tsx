import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ListEventsResponse, EventSummary } from '@cloud-webapp/shared';
import { apiGet } from '../lib/api.js';

export function Events(): JSX.Element {
  const [events, setEvents] = useState<EventSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet<ListEventsResponse>('/api/events')
      .then((r) => setEvents(r.events))
      .catch((e: Error) => setError(e.message));
  }, []);

  if (error) return <p className="error-text">Could not load events: {error}</p>;
  if (events === null) return <p className="muted">Loading events…</p>;
  if (events.length === 0) return <p className="muted">No events yet.</p>;

  return (
    <div>
      <h2>Events</h2>
      <ul className="event-list">
        {events.map((ev) => {
          const indexed = ev.indexState?.status === 'done';
          return (
            <li key={ev.id} className="event-card">
              <Link to={`/events/${ev.id}`} className="event-link">
                <span className="event-name">{ev.name || ev.id}</span>
                {ev.date && <span className="event-date">{ev.date}</span>}
                <span className={indexed ? 'badge badge-ok' : 'badge'}>
                  {indexed
                    ? `${ev.indexState?.photoCount ?? '?'} photos · Find Me ready`
                    : 'not indexed yet'}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
