import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type {
  AdminVerdictBatchListResponse,
  AdminVerdictBatchResponse,
  FeedbackVerdict,
  PhotoWebUrlResponse,
  VerdictBatch,
  VerdictBatchDetail,
} from '@cloud-webapp/shared';
import { Lightbox } from '../components/Lightbox.js';
import { apiGet, ApiError } from '../lib/api.js';
import { useStrings } from '../lib/i18n.js';

const STR = {
  en: {
    title: 'Verdict batches',
    lead: 'Each batch is one Find Me search: the selfie someone searched with, and every verdict they marked on its results.',
    adminOnly: 'This review page is admin-only — sign in with an admin account to view it.',
    batchesInView: (n: number) => `${n} ${n === 1 ? 'batch' : 'batches'}`,
    unattributed: (n: number) => `${n} not linked to a search`,
    unattributedHelp:
      'Verdicts recorded without a search run — see the flat Match feedback queue.',
    capped: 'Showing the most recent verdicts only — older batches exist beyond this window.',
    filterByEvent: 'Filter by event ID',
    filterByEmail: 'Filter by searcher email',
    refreshing: 'Refreshing…',
    refresh: 'Refresh',
    loading: 'Loading batches…',
    loadingBatch: 'Loading verdicts…',
    couldNotLoad: 'Could not load verdict batches.',
    noBatches: 'No verdict batches yet for this filter.',
    noVotes: 'The verdicts in this batch have been erased. Only the search record remains.',
    view: 'View verdicts',
    back: '← All batches',
    guest: 'Guest',
    selfie: 'Selfie searched with',
    selfieTapHint: 'Tap the selfie for a full-size look.',
    selfieGuess: 'selfie is a guess',
    selfieInferred:
      "Closest match, not certain: this search reused a saved selfie without recording which one, so this is the searcher's most recent selfie from before it.",
    noSelfie: 'Selfie unavailable',
    noSelfieWhy: 'It expired, the searcher erased their data, or they have no saved selfie.',
    confirmed: (n: number) => `${n} that's me`,
    wrong: (n: number) => `${n} not me`,
    judged: (n: number, of: number) => `${n} of ${of} results judged`,
    verdicts: (n: number) => `${n} ${n === 1 ? 'verdict' : 'verdicts'}`,
    thatsMe: "That's me",
    wrongMatch: 'Wrong match',
    searched: 'Searched',
    marked: 'Marked',
    mode: 'Mode',
    algo: 'Algorithm',
    rank: (n: number) => `#${n}`,
    openPhoto: 'Open photo',
  },
  zh: {
    title: '结论批次',
    lead: '每个批次对应一次「一键找我」搜索：显示搜索所用的自拍，以及用户对搜索结果标记的全部结论。',
    adminOnly: '此审核页面仅限管理员，请使用管理员账号登录查看。',
    batchesInView: (n: number) => `${n} 个批次`,
    unattributed: (n: number) => `${n} 条未关联搜索`,
    unattributedHelp: '这些结论没有对应的搜索记录，请在「匹配反馈」列表中查看。',
    capped: '仅显示最近的结论，更早的批次未包含在此窗口内。',
    filterByEvent: '按活动 ID 筛选',
    filterByEmail: '按搜索者邮箱筛选',
    refreshing: '刷新中…',
    refresh: '刷新',
    loading: '正在加载批次…',
    loadingBatch: '正在加载结论…',
    couldNotLoad: '无法加载结论批次。',
    noBatches: '此筛选条件下暂无结论批次。',
    noVotes: '此批次的结论已被删除，仅保留搜索记录。',
    view: '查看结论',
    back: '← 全部批次',
    guest: '访客',
    selfie: '搜索所用自拍',
    selfieTapHint: '点击自拍可查看大图。',
    selfieGuess: '自拍为推测',
    selfieInferred:
      '仅为最接近的推测：该次搜索复用了已保存的自拍但未记录具体是哪一张，此处显示的是该搜索者在此之前最近的一张自拍。',
    noSelfie: '自拍不可用',
    noSelfieWhy: '可能已过期、被用户删除，或该用户没有保存的自拍。',
    confirmed: (n: number) => `${n} 是我`,
    wrong: (n: number) => `${n} 不是我`,
    judged: (n: number, of: number) => `已标记 ${n} / ${of} 条结果`,
    verdicts: (n: number) => `${n} 条结论`,
    thatsMe: '是我',
    wrongMatch: '匹配错误',
    searched: '搜索时间',
    marked: '标记时间',
    mode: '模式',
    algo: '算法',
    rank: (n: number) => `第 ${n} 位`,
    openPhoto: '打开照片',
  },
};

/** Compact local date-time, matching the other admin tables. */
function fmtWhen(iso: string | null): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso || '—';
  return new Date(t).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function verdictClass(v: FeedbackVerdict): string {
  return v === 'confirmed' ? 'badge badge-ok' : 'badge badge-err';
}

/**
 * The selfie, clickable for a full-size look — at thumbnail size you can't tell
 * whether the searcher uploaded a usable face at all, which is half of what an
 * admin is here to judge. Falls back to a neutral placeholder (not a broken
 * image) when there is nothing to show.
 */
function Selfie({
  url,
  alt,
  className,
  onOpen,
}: {
  url: string | null;
  alt: string;
  className: string;
  onOpen: (url: string) => void;
}): JSX.Element {
  if (!url) return <div className={`${className} selfie-missing`} aria-hidden="true" />;
  return (
    <button type="button" className="selfie-btn" onClick={() => onOpen(url)} aria-label={alt}>
      <img className={className} src={url} alt={alt} loading="lazy" />
    </button>
  );
}

/**
 * Admin verdict-batch review (`GET /api/admin/verdict-batches`).
 *
 * The Match feedback page is a flat list of votes, which can't answer the
 * question an admin actually has — "was this search right?" — because a lone
 * "not me" says nothing without the face that was searched for and the sibling
 * verdicts from the same search. This groups verdicts the way they were made:
 * one selfie, one search, all of its verdicts side by side.
 *
 * Server-authoritative: a non-admin gets a 403, surfaced as a friendly empty
 * state (same pattern as FeedbackAdmin). Every load is audited server-side —
 * these are other people's selfies.
 */
export function AdminVerdicts(): JSX.Element {
  const t = useStrings(STR);
  const [data, setData] = useState<AdminVerdictBatchListResponse | null>(null);
  const [batch, setBatch] = useState<VerdictBatchDetail | null>(null);
  const [loadingBatch, setLoadingBatch] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [loading, setLoading] = useState(false);

  // Filters are applied server-side (before grouping) so the counts match.
  const [eventId, setEventId] = useState('');
  const [email, setEmail] = useState('');

  // Lightbox over the voted-on photos of the open batch. The full-size `web`
  // derivative is signed on demand, as in the gallery.
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [webUrls, setWebUrls] = useState<Record<string, string>>({});
  const webFetching = useRef<Set<string>>(new Set());
  // A selfie opened full-size. Separate from the photo lightbox: the selfie is
  // the query, not one of the results, so it has no place in that sequence.
  const [selfieOpen, setSelfieOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setForbidden(false);
    const qs = new URLSearchParams();
    if (eventId.trim()) qs.set('eventId', eventId.trim());
    if (email.trim()) qs.set('email', email.trim());
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    try {
      setData(await apiGet<AdminVerdictBatchListResponse>(`/api/admin/verdict-batches${suffix}`));
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) {
        setForbidden(true);
        setData(null);
      } else {
        setError(e instanceof Error ? e.message : t.couldNotLoad);
      }
    } finally {
      setLoading(false);
    }
  }, [eventId, email, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const openBatch = useCallback(
    async (runId: string) => {
      setLoadingBatch(true);
      setError(null);
      setLightboxIndex(null);
      setWebUrls({});
      webFetching.current.clear();
      try {
        const r = await apiGet<AdminVerdictBatchResponse>(
          `/api/admin/verdict-batches/${encodeURIComponent(runId)}`,
        );
        setBatch(r.batch);
      } catch (e) {
        setError(e instanceof Error ? e.message : t.couldNotLoad);
      } finally {
        setLoadingBatch(false);
      }
    },
    [t],
  );

  // Lazily sign the full-size URL for whichever photo the lightbox is showing.
  useEffect(() => {
    if (lightboxIndex === null || !batch) return;
    const vote = batch.votes[lightboxIndex];
    if (!vote || webUrls[vote.photoId] || webFetching.current.has(vote.photoId)) return;
    webFetching.current.add(vote.photoId);
    apiGet<PhotoWebUrlResponse>(
      `/api/events/${encodeURIComponent(batch.eventId)}/photos/${encodeURIComponent(vote.photoId)}/web`,
    )
      .then((r) => setWebUrls((prev) => ({ ...prev, [vote.photoId]: r.webUrl })))
      .catch(() => webFetching.current.delete(vote.photoId));
  }, [lightboxIndex, batch, webUrls]);

  if (forbidden) {
    return (
      <div>
        <h2>{t.title}</h2>
        <p className="muted">{t.adminOnly}</p>
      </div>
    );
  }

  // ── One batch: the selfie plus every verdict marked on that search ─────────
  if (batch) {
    const searcher = batch.name ?? batch.email ?? (batch.uid ? t.guest : '—');
    return (
      <div>
        <div className="gallery-header">
          <h2>{t.title}</h2>
          <button className="btn btn-light btn-sm" onClick={() => setBatch(null)}>
            {t.back}
          </button>
        </div>

        {error && <p className="error-text">{error}</p>}

        <div className="verdict-batch">
          <figure className="verdict-selfie">
            <Selfie
              url={batch.selfieUrl}
              alt={t.selfie}
              className="verdict-selfie-img"
              onOpen={setSelfieOpen}
            />
            <figcaption>
              {/* Name and email on ONE line — figcaption is a grid, so separate
                  children would each take their own row. */}
              <div>
                <strong>{searcher}</strong>
                {batch.email && batch.name && <span className="muted"> · {batch.email}</span>}
              </div>
              <div className="muted">
                <Link to={`/events/${batch.eventId}`} className="inline-link">
                  {batch.eventId}
                </Link>
              </div>
              {!batch.selfieUrl && <div className="muted">{t.noSelfie} — {t.noSelfieWhy}</div>}
              {batch.selfieUrl && (
                <div className="muted">
                  {batch.selfieSource === 'inferred' ? t.selfieInferred : t.selfieTapHint}
                </div>
              )}
            </figcaption>
          </figure>

          <dl className="verdict-facts">
            <dt>{t.searched}</dt>
            <dd>{fmtWhen(batch.searchedAt)}</dd>
            <dt>{t.marked}</dt>
            <dd>{fmtWhen(batch.markedAt)}</dd>
            <dt>{t.mode}</dt>
            <dd>{batch.mode ?? '—'}</dd>
            <dt>{t.algo}</dt>
            <dd className="mono">
              {batch.searchVersion ?? '—'}
              {batch.algo?.tnorm ? ' +tnorm' : ''}
              {batch.algo?.prf ? ` +prf(${batch.algo.prfCount})` : ''}
              {batch.algo && batch.algo.numReferences > 1 ? ` ×${batch.algo.numReferences}` : ''}
            </dd>
          </dl>
        </div>

        <div className="verdict-tallies">
          <span className="badge badge-ok">{t.confirmed(batch.counts.confirmed)}</span>
          <span className="badge badge-err">{t.wrong(batch.counts.not_me)}</span>
          <span className="muted event-stat">
            {batch.resultCount === null
              ? t.verdicts(batch.total)
              : t.judged(batch.total, batch.resultCount)}
          </span>
        </div>

        {batch.votes.length === 0 ? (
          <p className="muted">{t.noVotes}</p>
        ) : (
          <ul className="verdict-grid">
            {batch.votes.map((v, i) => (
              <li key={v.feedbackId || v.photoId} className="verdict-cell">
                <button
                  type="button"
                  className="photo-cell"
                  onClick={() => setLightboxIndex(i)}
                  aria-label={t.openPhoto}
                >
                  {v.thumbUrl ? (
                    <img src={v.thumbUrl} alt={v.photoId} loading="lazy" />
                  ) : (
                    <span className="selfie-missing" aria-hidden="true" />
                  )}
                </button>
                <div className="verdict-cell-meta">
                  <span className={verdictClass(v.verdict)}>
                    {v.verdict === 'confirmed' ? t.thatsMe : t.wrongMatch}
                  </span>
                  <span className="muted event-stat">
                    {v.rank !== null && `${t.rank(v.rank)} `}
                    {v.score !== null && v.score.toFixed(2)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}

        {lightboxIndex !== null && batch.votes[lightboxIndex] && (
          <Lightbox
            items={batch.votes.map((v) => ({
              key: v.photoId,
              src: webUrls[v.photoId] ?? v.thumbUrl,
              fallbackSrc: v.thumbUrl,
              alt: v.photoId,
              badge: (
                <span className={verdictClass(v.verdict)}>
                  {v.verdict === 'confirmed' ? t.thatsMe : t.wrongMatch}
                </span>
              ),
            }))}
            index={lightboxIndex}
            onClose={() => setLightboxIndex(null)}
            onNavigate={setLightboxIndex}
          />
        )}

        {selfieOpen && <SelfieLightbox url={selfieOpen} alt={t.selfie} onClose={() => setSelfieOpen(null)} />}
      </div>
    );
  }

  // ── The list of recent batches ────────────────────────────────────────────
  return (
    <div>
      <div className="gallery-header">
        <h2>{t.title}</h2>
        {data && (
          <div className="event-meta">
            <span className="badge">{t.batchesInView(data.total)}</span>
            {data.unattributed > 0 && (
              <span className="muted event-stat" title={t.unattributedHelp}>
                {t.unattributed(data.unattributed)}
              </span>
            )}
          </div>
        )}
      </div>
      <p className="muted">{t.lead}</p>

      <div className="feedback-filters">
        <input
          className="feedback-input"
          type="text"
          placeholder={t.filterByEvent}
          value={eventId}
          onChange={(e) => setEventId(e.target.value)}
        />
        <input
          className="feedback-input"
          type="text"
          placeholder={t.filterByEmail}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <button className="btn btn-light btn-sm" onClick={() => void load()} disabled={loading}>
          {loading ? t.refreshing : t.refresh}
        </button>
      </div>

      {error && <p className="error-text">{error}</p>}
      {loadingBatch && <p className="muted">{t.loadingBatch}</p>}

      {data === null ? (
        <p className="muted">{t.loading}</p>
      ) : data.batches.length === 0 ? (
        <p className="muted">{t.noBatches}</p>
      ) : (
        <>
          {data.capped && <p className="muted">{t.capped}</p>}
          <ul className="batch-list">
            {data.batches.map((b: VerdictBatch) => (
              <li key={b.runId} className="batch-card">
                <Selfie
                  url={b.selfieUrl}
                  alt={t.selfie}
                  className="batch-selfie"
                  onOpen={setSelfieOpen}
                />
                <div className="batch-body">
                  <div className="batch-who">
                    <strong>{b.name ?? b.email ?? t.guest}</strong>
                    {b.email && b.name && <span className="muted"> · {b.email}</span>}
                    {b.selfieSource === 'inferred' && (
                      <span className="badge badge-warn" title={t.selfieInferred}>
                        {t.selfieGuess}
                      </span>
                    )}
                  </div>
                  {/* A wrapping flex row, not "id · time" text: the event id is a
                      full uuid and the manual separator stranded itself on its
                      own line on narrow screens. */}
                  <div className="muted batch-meta">
                    <Link to={`/events/${b.eventId}`} className="inline-link">
                      {b.eventId}
                    </Link>
                    <span>{fmtWhen(b.markedAt)}</span>
                  </div>
                  <div className="batch-tallies">
                    <span className="badge badge-ok">{t.confirmed(b.counts.confirmed)}</span>
                    <span className="badge badge-err">{t.wrong(b.counts.not_me)}</span>
                    <span className="muted event-stat">
                      {b.resultCount === null ? t.verdicts(b.total) : t.judged(b.total, b.resultCount)}
                    </span>
                  </div>
                </div>
                <button
                  className="btn btn-light btn-sm"
                  onClick={() => void openBatch(b.runId)}
                  disabled={loadingBatch}
                >
                  {t.view}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {selfieOpen && <SelfieLightbox url={selfieOpen} alt={t.selfie} onClose={() => setSelfieOpen(null)} />}
    </div>
  );
}

/** The selfie at full size. One item, so the lightbox shows no prev/next. */
function SelfieLightbox({
  url,
  alt,
  onClose,
}: {
  url: string;
  alt: string;
  onClose: () => void;
}): JSX.Element {
  return (
    <Lightbox
      items={[{ key: 'selfie', src: url, alt }]}
      index={0}
      onClose={onClose}
      onNavigate={() => undefined}
    />
  );
}
