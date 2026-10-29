import { useCallback, useEffect, useState } from 'react';
import { Link as RouterLink, useParams } from 'react-router-dom';
import type {
  ClubRecord,
  GetEventResponse,
  LinkRecord,
  LinkResponse,
  ListClubsResponse,
  ListLinksResponse,
} from '@cloud-webapp/shared';
import { apiGet, apiPost, ApiError } from '../lib/api.js';
import { eventLabel } from '../lib/eventLabel.js';
import { buildLinksMessage } from '../lib/linksMessage.js';
import { useStrings } from '../lib/i18n.js';

const STR = {
  en: {
    couldNotLoad: 'Could not load links.',
    actionFailed: 'Action failed.',
    couldNotCopy: 'Could not copy to clipboard.',
    title: 'Upload links',
    adminOnly: 'Link management is admin-only — sign in with an admin account.',
    allEvents: '← All events',
    event: 'Event',
    club: 'Club',
    selectClub: 'Select club…',
    clubId: 'Club id',
    tagPlaceholder: 'Tag (optional, e.g. finish_line)',
    generateLink: 'Generate link',
    loading: 'Loading links…',
    noLinks: 'No links yet for this event.',
    colClub: 'Club',
    colTag: 'Tag',
    colVer: 'Ver',
    colStatus: 'Status',
    colLink: 'Link',
    colActions: 'Actions',
    copied: 'Copied!',
    copyUrl: 'Copy URL',
    rotate: 'Rotate',
    revoke: 'Revoke',
    shareTitle: 'Share message',
    shareHint: 'Bilingual (中文 + English) text with every active link and how to use Find Me — paste it into the group chat.',
    generateMessage: 'Generate message',
    copyMessage: 'Copy message',
    messageLabel: 'Share message text',
  },
  zh: {
    couldNotLoad: '无法加载链接。',
    actionFailed: '操作失败。',
    couldNotCopy: '无法复制到剪贴板。',
    title: '上传链接',
    adminOnly: '链接管理仅限管理员，请使用管理员账号登录。',
    allEvents: '← 全部活动',
    event: '活动',
    club: '俱乐部',
    selectClub: '选择俱乐部…',
    clubId: '俱乐部 ID',
    tagPlaceholder: '标签（可选，例如 finish_line）',
    generateLink: '生成链接',
    loading: '正在加载链接…',
    noLinks: '本次活动暂无链接。',
    colClub: '俱乐部',
    colTag: '标签',
    colVer: '版本',
    colStatus: '状态',
    colLink: '链接',
    colActions: '操作',
    copied: '已复制！',
    copyUrl: '复制链接',
    rotate: '轮换',
    revoke: '吊销',
    shareTitle: '分享文案',
    shareHint: '中英双语文案，包含所有有效的上传链接和人脸识别使用说明，可直接粘贴到群里。',
    generateMessage: '生成文案',
    copyMessage: '复制文案',
    messageLabel: '分享文案内容',
  },
};

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
  const t = useStrings(STR);
  const { eventId = '' } = useParams();
  const [links, setLinks] = useState<LinkRecord[] | null>(null);
  const [clubs, setClubs] = useState<ClubRecord[]>([]);
  const [clubNames, setClubNames] = useState<Map<string, string>>(new Map());
  const [eventName, setEventName] = useState('');
  const [message, setMessage] = useState<string | null>(null);
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
        // All clubs, not just active: a link can outlive its club's status.
        setClubNames(new Map(c.clubs.map((x) => [x.normalizedName, x.displayName || x.normalizedName])));
      } catch {
        /* non-fatal */
      }
      try {
        const ev = await apiGet<GetEventResponse>(`/api/events/${encodeURIComponent(eventId)}`);
        setEventName(eventLabel({ name: ev.event.name, date: ev.event.date, id: eventId, hasPhotos: true }));
      } catch {
        /* non-fatal — the message falls back to a short id */
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) setForbidden(true);
      else setError(e instanceof Error ? e.message : t.couldNotLoad);
    }
  }, [eventId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(fn: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await fn();
      // A rotate/revoke/new link changes the tokens; drop a message built
      // from the old ones rather than let it be copied.
      setMessage(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t.actionFailed);
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
    await copyText(uploadUrl(token), token);
  }

  async function copyText(text: string, key: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      setError(t.couldNotCopy);
    }
  }

  function generateMessage(): void {
    if (!links) return;
    setMessage(
      buildLinksMessage({
        eventName: eventName || eventLabel({ id: eventId, hasPhotos: true }),
        eventId,
        origin: window.location.origin,
        links,
        clubDisplayNames: clubNames,
      }),
    );
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
        <RouterLink to="/admin/events" className="muted nav-link">
          {t.allEvents}
        </RouterLink>
      </div>
      <p className="muted">
        {t.event} <span className="mono">{eventId}</span>
      </p>

      <div className="feedback-filters">
        {clubs.length > 0 ? (
          <select className="feedback-input" value={clubName} onChange={(e) => setClubName(e.target.value)} aria-label={t.club}>
            <option value="">{t.selectClub}</option>
            {clubs.map((c) => (
              <option key={c.normalizedName} value={c.normalizedName}>
                {c.displayName}
              </option>
            ))}
          </select>
        ) : (
          <input className="feedback-input" placeholder={t.clubId} value={clubName} onChange={(e) => setClubName(e.target.value)} />
        )}
        <input
          className="feedback-input"
          placeholder={t.tagPlaceholder}
          value={tag}
          onChange={(e) => setTag(e.target.value)}
        />
        <button className="btn btn-primary btn-sm" onClick={() => void generate()} disabled={busy}>
          {t.generateLink}
        </button>
      </div>

      {error && <p className="error-text">{error}</p>}

      {links === null ? (
        <p className="muted">{t.loading}</p>
      ) : links.length === 0 ? (
        <p className="muted">{t.noLinks}</p>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>{t.colClub}</th>
                <th>{t.colTag}</th>
                <th>{t.colVer}</th>
                <th>{t.colStatus}</th>
                <th>{t.colLink}</th>
                <th>{t.colActions}</th>
              </tr>
            </thead>
            <tbody>
              {links.map((l) => (
                <tr key={l.linkId}>
                  <td className="mono" data-label={t.colClub}>{l.clubName}</td>
                  <td data-label={t.colTag}>{l.tag}</td>
                  <td className="muted" data-label={t.colVer}>{l.version}</td>
                  <td data-label={t.colStatus}>
                    <span className={l.status === 'active' ? 'badge badge-ok' : 'badge badge-err'}>{l.status}</span>
                  </td>
                  <td data-label={t.colLink}>
                    {l.status === 'active' ? (
                      <button className="btn btn-light btn-sm" onClick={() => void copy(l.token)} disabled={busy}>
                        {copied === l.token ? t.copied : t.copyUrl}
                      </button>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td data-label={t.colActions}>
                    {l.status === 'active' && (
                      <>
                        <button className="btn btn-light btn-sm" onClick={() => void act(() => apiPost<LinkResponse>(`/api/admin/links/${encodeURIComponent(l.linkId)}/rotate`, {}))} disabled={busy}>
                          {t.rotate}
                        </button>{' '}
                        <button className="btn btn-light btn-sm" onClick={() => void act(() => apiPost<LinkResponse>(`/api/admin/links/${encodeURIComponent(l.linkId)}/revoke`, {}))} disabled={busy}>
                          {t.revoke}
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

      {links !== null && (
        <section className="links-share">
          <h3>{t.shareTitle}</h3>
          <p className="muted">{t.shareHint}</p>
          <div className="feedback-filters">
            <button className="btn btn-primary btn-sm" onClick={generateMessage} disabled={busy}>
              {t.generateMessage}
            </button>
            {message !== null && (
              <button className="btn btn-light btn-sm" onClick={() => void copyText(message, 'message')}>
                {copied === 'message' ? t.copied : t.copyMessage}
              </button>
            )}
          </div>
          {message !== null && (
            <textarea
              className="feedback-input links-share-text"
              aria-label={t.messageLabel}
              readOnly
              rows={18}
              value={message}
              onFocus={(e) => e.currentTarget.select()}
            />
          )}
        </section>
      )}
    </div>
  );
}
