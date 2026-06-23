import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type {
  ListEventsResponse,
  EventSummary,
  TriggerIndexResponse,
  SyncResponse,
} from '@cloud-webapp/shared';
import { apiGet, apiPost, ApiError } from '../lib/api.js';
import { eventLabel } from '../lib/eventLabel.js';
import { useStrings } from '../lib/i18n.js';

const STR = {
  en: {
    loadError: 'Could not load events',
    loading: 'Loading events…',
    title: 'Events',
    sync: 'Sync with Drive',
    syncing: 'Syncing…',
    noEvents: 'No events yet.',
    photos: (n: number): string => `${n} photos`,
    indexNow: 'Index now',
    indexing: 'Indexing…',
    starting: 'Starting…',
    pill: {
      done: 'Find Me ready',
      queued: 'Queued…',
      running: 'Indexing…',
      failed: 'Index failed',
      none: 'Not indexed',
    },
    time: {
      justNow: 'updated just now',
      min: (n: number): string => `updated ${n} min ago`,
      hr: (n: number): string => `updated ${n} hr ago`,
      day: (n: number): string => `updated ${n} day${n === 1 ? '' : 's'} ago`,
    },
    syncOk: (created: number, updated: number, unchanged: number, orphans: number): string =>
      `Synced with Drive — ${created} new, ${updated} updated, ${unchanged} unchanged` +
      (orphans ? `, ${orphans} not in Sheet` : '') +
      '.',
    syncAdminOnly: 'Sync is admin-only — sign in as an admin to run it.',
    syncNotConfigured:
      'Sync is not configured yet (MASTER_SPREADSHEET_ID is unset on the API).',
    syncFailed: 'Could not sync with Drive.',
    indexAdminOnly: 'Indexing is admin-only — sign in as an admin to run it.',
    indexInProgress: 'An index run is already in progress for that event.',
    indexFailed: 'Could not start indexing.',
  },
  zh: {
    loadError: '无法加载活动',
    loading: '正在加载活动…',
    title: '活动',
    sync: '与 Drive 同步',
    syncing: '同步中…',
    noEvents: '暂无活动。',
    photos: (n: number): string => `${n} 张照片`,
    indexNow: '立即建立索引',
    indexing: '建立索引中…',
    starting: '启动中…',
    pill: {
      done: '「找到我」就绪',
      queued: '排队中…',
      running: '建立索引中…',
      failed: '索引失败',
      none: '未建立索引',
    },
    time: {
      justNow: '刚刚更新',
      min: (n: number): string => `${n} 分钟前更新`,
      hr: (n: number): string => `${n} 小时前更新`,
      day: (n: number): string => `${n} 天前更新`,
    },
    syncOk: (created: number, updated: number, unchanged: number, orphans: number): string =>
      `已与 Drive 同步——新增 ${created}，更新 ${updated}，未变 ${unchanged}` +
      (orphans ? `，${orphans} 个不在表格中` : '') +
      '。',
    syncAdminOnly: '同步仅限管理员，请以管理员身份登录后运行。',
    syncNotConfigured: '同步尚未配置（API 上未设置 MASTER_SPREADSHEET_ID）。',
    syncFailed: '无法与 Drive 同步。',
    indexAdminOnly: '建立索引仅限管理员，请以管理员身份登录后运行。',
    indexInProgress: '该活动已有一个索引任务正在进行中。',
    indexFailed: '无法开始建立索引。',
  },
};

type TimeStrings = (typeof STR)['en']['time'];

/** Compact "updated x ago" for the last-indexed timestamp, in the current language. */
function timeAgo(iso: string | undefined, time: TimeStrings): string {
  if (!iso) return '';
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 45) return time.justNow;
  const mins = Math.round(secs / 60);
  if (mins < 60) return time.min(mins);
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return time.hr(hrs);
  const days = Math.round(hrs / 24);
  return time.day(days);
}

/** Sort events most-recently-synced first, then newest event date.
 *  Both keys are ISO strings, so a lexical compare is chronological.
 *  Missing keys sort to the bottom of their level. */
function bySyncThenDate(a: EventSummary, b: EventSummary): number {
  const sa = a.lastSyncedAt ?? '';
  const sb = b.lastSyncedAt ?? '';
  if (sa !== sb) {
    if (sa && sb) return sb.localeCompare(sa);
    return sa ? -1 : 1;
  }
  const da = a.date ?? '';
  const db = b.date ?? '';
  if (da && db) return db.localeCompare(da);
  if (da) return -1;
  if (db) return 1;
  return 0;
}

type PillKey = 'done' | 'queued' | 'running' | 'failed' | 'none';

interface StatusPill {
  key: PillKey;
  className: string;
  inFlight: boolean;
}

function pillFor(ev: EventSummary): StatusPill {
  switch (ev.indexState?.status) {
    case 'done':
      return { key: 'done', className: 'badge badge-ok', inFlight: false };
    case 'queued':
      return { key: 'queued', className: 'badge badge-warn', inFlight: true };
    case 'running':
      return { key: 'running', className: 'badge badge-warn', inFlight: true };
    case 'failed':
      return { key: 'failed', className: 'badge badge-err', inFlight: false };
    default:
      return { key: 'none', className: 'badge', inFlight: false };
  }
}

interface EventsProps {
  /** Guests (anonymous sign-in) can browse + Find Me, but not run admin
   *  actions (Index / Sync). Those controls are hidden for them; the API also
   *  rejects them since an anonymous session has no admin email. */
  isGuest?: boolean;
}

export function Events({ isGuest = false }: EventsProps): JSX.Element {
  const t = useStrings(STR);
  const [events, setEvents] = useState<EventSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  const load = useCallback(async () => {
    const r = await apiGet<ListEventsResponse>('/api/events');
    setEvents([...r.events].sort(bySyncThenDate));
  }, []);

  async function syncWithDrive(): Promise<void> {
    setSyncing(true);
    setNotice(null);
    try {
      const r = await apiPost<SyncResponse>('/api/admin/sync', {});
      setNotice(t.syncOk(r.created, r.updated, r.unchanged, r.orphans.length));
      await load();
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) {
        setNotice(t.syncAdminOnly);
      } else if (e instanceof ApiError && e.status === 503) {
        setNotice(t.syncNotConfigured);
      } else {
        setNotice(e instanceof Error ? e.message : t.syncFailed);
      }
    } finally {
      setSyncing(false);
    }
  }

  useEffect(() => {
    load().catch((e: Error) => setError(e.message));
  }, [load]);

  // Auto-refresh so photo counts / status update without a manual reload:
  //   • Fast (5s) while a job is queued/running, so progress shows live and the
  //     pill flips to "Find Me ready" the moment the run finishes.
  //   • Slow (20s) otherwise, so externally-triggered indexing — e.g. a GAS
  //     upload firing POST /api/events/:id/index — gets picked up even when this
  //     tab was idle showing everything "done".
  //   • Plus an immediate refetch when the tab regains focus/visibility.
  //   • Gated on document visibility: no polling while the tab is hidden, so we
  //     don't hold the scale-to-zero API warm in the background (cost policy).
  const anyInFlight = (events ?? []).some((e) => pillFor(e).inFlight);
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    const refetchIfVisible = (): void => {
      if (document.visibilityState === 'visible') loadRef.current().catch(() => undefined);
    };
    const delay = anyInFlight ? 5000 : 20000;
    const id = setInterval(refetchIfVisible, delay);
    document.addEventListener('visibilitychange', refetchIfVisible);
    window.addEventListener('focus', refetchIfVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', refetchIfVisible);
      window.removeEventListener('focus', refetchIfVisible);
    };
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
        setNotice(t.indexAdminOnly);
      } else if (e instanceof ApiError && e.status === 409) {
        setNotice(t.indexInProgress);
      } else {
        setNotice(e instanceof Error ? e.message : t.indexFailed);
      }
    } finally {
      setBusyId(null);
    }
  }

  if (error) return <p className="error-text">{t.loadError}：{error}</p>;
  if (events === null) return <p className="muted">{t.loading}</p>;

  return (
    <div>
      <div className="page-head">
        <h2>{t.title}</h2>
        {!isGuest && (
          <button className="btn btn-light" onClick={() => void syncWithDrive()} disabled={syncing}>
            {syncing ? t.syncing : t.sync}
          </button>
        )}
      </div>
      {notice && <p className="error-text">{notice}</p>}
      {events.length === 0 ? (
        <p className="muted">{t.noEvents}</p>
      ) : (
        <ul className="event-list">
          {events.map((ev) => {
            const pill = pillFor(ev);
            const photoCount = ev.indexState?.photoCount;
            const updated = timeAgo(ev.indexState?.updatedAt, t.time);
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
                    <span className={pill.className}>{t.pill[pill.key]}</span>
                    {typeof photoCount === 'number' && (
                      <span className="muted event-stat">{t.photos(photoCount)}</span>
                    )}
                    {updated && <span className="muted event-stat">{updated}</span>}
                    {!isGuest && (
                      <button
                        className="btn btn-light btn-sm"
                        onClick={() => void indexNow(ev.id)}
                        disabled={busyId === ev.id || pill.inFlight}
                      >
                        {pill.inFlight ? t.indexing : busyId === ev.id ? t.starting : t.indexNow}
                      </button>
                    )}
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
