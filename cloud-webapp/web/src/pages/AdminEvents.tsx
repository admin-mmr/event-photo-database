import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type {
  CreateEventResponse,
  DeleteEventResponse,
  EventSummary,
  ListEventsResponse,
} from '@cloud-webapp/shared';
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
    colDelete: 'Delete',
    manageLinks: 'Manage links',
    delete: 'Delete',
    checking: 'Checking…',
    deleting: 'Deleting…',
    deleteHeading: (name: string): string => `Delete "${name}"?`,
    inventory: (d: DeleteEventResponse): string =>
      `${d.inventory.photos} photo(s), ${d.inventory.activeLinks} active upload link(s), ` +
      `${d.inventory.derivativeObjects}${d.inventory.derivativeObjectsCapped ? '+' : ''} stored file(s).`,
    recoverable:
      'The Drive folder is moved to trash (restorable from "Deleted files"), not permanently deleted. ' +
      'Staged uploads are never touched.',
    typeToConfirm: (name: string): string => `Type "${name}" to confirm`,
    confirmDelete: 'Delete event',
    cancel: 'Cancel',
    couldNotPreview: 'Could not check what this event holds.',
    couldNotDelete: 'Could not delete the event.',
    superAdminOnly: 'Deleting an event is super-admin only.',
    finishRun: 'Not finished — run the delete again to remove the rest.',
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
    colDelete: '删除',
    manageLinks: '管理链接',
    delete: '删除',
    checking: '检查中…',
    deleting: '删除中…',
    deleteHeading: (name: string): string => `确定删除“${name}”？`,
    inventory: (d: DeleteEventResponse): string =>
      `${d.inventory.photos} 张照片、${d.inventory.activeLinks} 个有效上传链接、` +
      `${d.inventory.derivativeObjects}${d.inventory.derivativeObjectsCapped ? '+' : ''} 个存储文件。`,
    recoverable: 'Drive 文件夹会移入回收站（可从“已删除文件”恢复），不会永久删除；暂存的上传文件不会被删除。',
    typeToConfirm: (name: string): string => `请输入“${name}”以确认`,
    confirmDelete: '删除活动',
    cancel: '取消',
    couldNotPreview: '无法检查该活动包含的内容。',
    couldNotDelete: '无法删除活动。',
    superAdminOnly: '删除活动仅限超级管理员。',
    finishRun: '尚未完成——请再次执行删除以清除剩余内容。',
  },
};

interface AdminEventsProps {
  /** Deleting is super-admin only server-side; hide the control for everyone
   *  else rather than offering a button that can only 403. */
  isSuperAdmin?: boolean;
}

/**
 * Events admin (dev plan G3.1/G3.3). Create an event (provisions a Drive folder
 * + Sheet row server-side), jump to its upload-link management, and — for
 * super_admins — delete it. Layout reuses the responsive `feedback-filters`
 * (wraps) + `table-wrap` (scrolls) classes so it works on a phone.
 *
 * The delete is deliberately two steps: the first click only PREVIEWS (a
 * read-only inventory of what the event holds), and the apply needs the event's
 * name typed in. Same contract as the API, which refuses an apply whose
 * `confirmName` doesn't match.
 */
export function AdminEvents({ isSuperAdmin = false }: AdminEventsProps): JSX.Element {
  const t = useStrings(STR);
  const [events, setEvents] = useState<EventSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [busy, setBusy] = useState(false);

  const [name, setName] = useState('');
  const [date, setDate] = useState('');

  // Delete flow: preview held per row, plus the typed confirmation.
  const [pending, setPending] = useState<DeleteEventResponse | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [deleteBusyId, setDeleteBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

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

  /** Step 1 — read-only: what does this event actually hold? */
  async function startDelete(ev: EventSummary): Promise<void> {
    setDeleteBusyId(ev.id);
    setNotice(null);
    setError(null);
    setConfirmText('');
    try {
      const preview = await apiGet<DeleteEventResponse>(
        `/api/admin/events/${encodeURIComponent(ev.id)}/delete-preview`,
      );
      setPending(preview);
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) setNotice(t.superAdminOnly);
      else setNotice(e instanceof Error ? e.message : t.couldNotPreview);
    } finally {
      setDeleteBusyId(null);
    }
  }

  /** Step 2 — apply, with the typed name echoed back to the server. */
  async function confirmDelete(): Promise<void> {
    if (!pending) return;
    setDeleteBusyId(pending.eventId);
    setNotice(null);
    try {
      const out = await apiPost<DeleteEventResponse>(
        `/api/admin/events/${encodeURIComponent(pending.eventId)}/delete`,
        { apply: true, confirmName: confirmText.trim() },
      );
      // Report exactly what happened — a partial run (derivatives sweep out of
      // budget, a failed step) answers 200 with warnings, not an error.
      setNotice(
        [out.message, out.derivativesRemaining ? t.finishRun : '', ...out.warnings].filter(Boolean).join(' '),
      );
      // Keep the panel open while there is more to do, so "run again" is one click.
      setPending(out.derivativesRemaining ? { ...out, apply: false } : null);
      setConfirmText(out.derivativesRemaining ? confirmText : '');
      await load();
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) setNotice(t.superAdminOnly);
      else setNotice(e instanceof Error ? e.message : t.couldNotDelete);
    } finally {
      setDeleteBusyId(null);
    }
  }

  const confirmLabel = pending ? pending.eventName || pending.eventId : '';
  const confirmOk =
    pending !== null &&
    (confirmText.trim().toLowerCase() === pending.eventName.trim().toLowerCase() ||
      confirmText.trim() === pending.eventId) &&
    confirmText.trim() !== '';

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
      {notice && <p className="error-text">{notice}</p>}

      {pending && (
        <section className="danger-zone">
          <h3>{t.deleteHeading(confirmLabel)}</h3>
          <p className="muted">{t.inventory(pending)}</p>
          <p className="muted">{t.recoverable}</p>
          {pending.warnings.map((w) => (
            <p className="muted" key={w}>
              {w}
            </p>
          ))}
          <div className="feedback-filters">
            <input
              className="feedback-input"
              value={confirmText}
              placeholder={t.typeToConfirm(confirmLabel)}
              aria-label={t.typeToConfirm(confirmLabel)}
              onChange={(e) => setConfirmText(e.target.value)}
            />
            <button
              className="btn btn-danger btn-sm"
              onClick={() => void confirmDelete()}
              disabled={!confirmOk || deleteBusyId === pending.eventId}
            >
              {deleteBusyId === pending.eventId ? t.deleting : t.confirmDelete}
            </button>
            <button
              className="btn btn-light btn-sm"
              onClick={() => {
                setPending(null);
                setConfirmText('');
              }}
              disabled={deleteBusyId === pending.eventId}
            >
              {t.cancel}
            </button>
          </div>
        </section>
      )}

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
                {isSuperAdmin && <th>{t.colDelete}</th>}
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
                  {isSuperAdmin && (
                    <td data-label={t.colDelete}>
                      <button
                        className="btn btn-danger btn-sm"
                        onClick={() => void startDelete(ev)}
                        disabled={deleteBusyId !== null || pending?.eventId === ev.id}
                      >
                        {deleteBusyId === ev.id ? t.checking : t.delete}
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
