import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { CreateEventResponse, EventSummary, ListEventsResponse } from '@cloud-webapp/shared';
import { apiGet, apiPost, ApiError } from '../lib/api.js';
import { useStrings } from '../lib/i18n.js';

const STR = {
  en: {
    couldNotLoad: 'Could not load events.',
    couldNotCreate: 'Could not create event.',
    title: 'Events',
    adminOnly: 'Event management is admin-only — sign in with an admin account.',
    refresh: 'Refresh',
    eventName: 'Event name',
    eventDate: 'Event date',
    createEvent: 'Create event',
    loading: 'Loading events…',
    noEvents: 'No events yet.',
    colName: 'Name',
    colDate: 'Date',
    colIndex: 'Index',
    colLinks: 'Links',
    manageLinks: 'Manage links',
  },
  zh: {
    couldNotLoad: '无法加载活动。',
    couldNotCreate: '无法创建活动。',
    title: '活动',
    adminOnly: '活动管理仅限管理员，请使用管理员账号登录。',
    refresh: '刷新',
    eventName: '活动名称',
    eventDate: '活动日期',
    createEvent: '创建活动',
    loading: '正在加载活动…',
    noEvents: '暂无活动。',
    colName: '名称',
    colDate: '日期',
    colIndex: '索引',
    colLinks: '链接',
    manageLinks: '管理链接',
  },
};

/**
 * Events admin (dev plan G3.1/G3.3). Create an event (provisions a Drive folder
 * + Sheet row server-side) and jump to its upload-link management. Layout reuses
 * the responsive `feedback-filters` (wraps) + `table-wrap` (scrolls) classes so
 * it works on a phone.
 */
export function AdminEvents(): JSX.Element {
  const t = useStrings(STR);
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
      else setError(e instanceof Error ? e.message : t.couldNotLoad);
    }
  }, [t]);

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
      setError(e instanceof Error ? e.message : t.couldNotCreate);
    } finally {
      setBusy(false);
    }
  }

  if (forbidden) {
    return (
      <div>
        <h2>{t.title}</h2>
        <p className="muted">{t.adminOnly}</p>
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
        <input className="feedback-input" placeholder={t.eventName} value={name} onChange={(e) => setName(e.target.value)} />
        <input
          className="feedback-input"
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          aria-label={t.eventDate}
        />
        <button className="btn btn-primary btn-sm" onClick={() => void create()} disabled={busy}>
          {t.createEvent}
        </button>
      </div>

      {error && <p className="error-text">{error}</p>}

      {events === null ? (
        <p className="muted">{t.loading}</p>
      ) : events.length === 0 ? (
        <p className="muted">{t.noEvents}</p>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>{t.colName}</th>
                <th>{t.colDate}</th>
                <th>{t.colIndex}</th>
                <th>{t.colLinks}</th>
              </tr>
            </thead>
            <tbody>
              {events.map((ev) => (
                <tr key={ev.id}>
                  <td data-label={t.colName}>{ev.name || ev.id}</td>
                  <td className="muted" data-label={t.colDate}>{ev.date || '—'}</td>
                  <td className="muted" data-label={t.colIndex}>{ev.indexState?.status ?? '—'}</td>
                  <td data-label={t.colLinks}>
                    <Link className="btn btn-light btn-sm" to={`/admin/events/${encodeURIComponent(ev.id)}/links`}>
                      {t.manageLinks}
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
