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
      else setError(e instanceof Error ? e.message : 'Could not load events. · 无法加载活动。');
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
      setError(e instanceof Error ? e.message : 'Could not create event. · 无法创建活动。');
    } finally {
      setBusy(false);
    }
  }

  if (forbidden) {
    return (
      <div>
        <h2>Events · 活动</h2>
        <p className="muted">
          Event management is admin-only — sign in with an admin account. ·
          活动管理仅限管理员，请使用管理员账号登录。
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="gallery-header">
        <h2>Events · 活动</h2>
        <button className="btn btn-light btn-sm" onClick={() => void load()} disabled={busy}>
          Refresh · 刷新
        </button>
      </div>

      <div className="feedback-filters">
        <input className="feedback-input" placeholder="Event name · 活动名称" value={name} onChange={(e) => setName(e.target.value)} />
        <input
          className="feedback-input"
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          aria-label="Event date · 活动日期"
        />
        <button className="btn btn-primary btn-sm" onClick={() => void create()} disabled={busy}>
          Create event · 创建活动
        </button>
      </div>

      {error && <p className="error-text">{error}</p>}

      {events === null ? (
        <p className="muted">Loading events… · 正在加载活动…</p>
      ) : events.length === 0 ? (
        <p className="muted">No events yet. · 暂无活动。</p>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Name · 名称</th>
                <th>Date · 日期</th>
                <th>Index · 索引</th>
                <th>Links · 链接</th>
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
                      Manage links · 管理链接
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
