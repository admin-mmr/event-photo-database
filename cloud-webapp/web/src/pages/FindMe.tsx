import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type {
  SearchResponse,
  MatchResult,
  DownloadRequest,
  FeedbackRequest,
} from '@cloud-webapp/shared';
import { apiUpload, apiPost, apiDownloadFile, ApiError } from '../lib/api.js';
import { useSelection } from '../lib/selection.js';
import { combineReferences, visibleResults } from '../lib/results.js';
import { SelectBar } from '../components/SelectBar.js';

type Phase = 'consent' | 'pick' | 'searching' | 'results';

/** One reference selfie and the result set it produced. Result sets are kept
 *  separate per reference (B3) — they only merge in the explicit Combined view. */
interface Reference {
  id: string;
  previewUrl: string;
  label: string;
  runId?: string;
  mode: string;
  results: MatchResult[];
  hidden: Set<string>; // photoIds removed via "not me" (B7)
}

const COMBINED = 'combined';

function withRemoved(set: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(set);
  next.delete(id);
  return next;
}

/**
 * Find Me flow. Consent → selfie upload → per-selfie results, with a reference
 * picker to switch between uploads, an explicit deduped Combined view (B3),
 * multi-select original-resolution ZIP download (B1/B2), and "not me / that's
 * me" feedback that removes wrong matches optimistically (B7).
 */
export function FindMe(): JSX.Element {
  const { eventId = '' } = useParams();
  const [phase, setPhase] = useState<Phase>('consent');
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [references, setReferences] = useState<Reference[]>([]);
  const [activeId, setActiveId] = useState<string>(COMBINED);
  const [confirmed, setConfirmed] = useState<Set<string>>(new Set());
  const [downloading, setDownloading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const activeRef = references.find((r) => r.id === activeId);
  const isCombined = activeId === COMBINED || !activeRef;

  const visible = useMemo<MatchResult[]>(() => {
    if (references.length === 0) return [];
    if (isCombined) return combineReferences(references);
    return activeRef ? visibleResults(activeRef) : [];
  }, [references, isCombined, activeRef]);

  const ids = useMemo(() => visible.map((r) => r.photoId), [visible]);
  const sel = useSelection(ids);

  // Switching the active reference clears the current selection — selecting in
  // one view shouldn't carry into another (no cross-upload blending).
  useEffect(() => {
    sel.selectNone();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  async function search(file: File): Promise<void> {
    setPhase('searching');
    setError(null);
    const form = new FormData();
    form.set('file', file);
    form.set('eventId', eventId);
    form.set('consent', 'true');
    try {
      const res = await apiUpload<SearchResponse>('/api/findme/search', form);
      const ref: Reference = {
        id: res.runId ?? crypto.randomUUID(),
        previewUrl: URL.createObjectURL(file),
        label: `Photo ${references.length + 1}`,
        ...(res.runId !== undefined ? { runId: res.runId } : {}),
        mode: res.mode,
        results: res.results,
        hidden: new Set(),
      };
      setReferences((prev) => [...prev, ref]);
      setActiveId(ref.id);
      setPhase('results');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'no_usable_face') {
        setError('We couldn’t find a clear face in that photo. Try a sharper, front-facing picture with good lighting.');
        setPhase('pick');
      } else if (e instanceof ApiError && e.code === 'event_not_indexed') {
        setError('This event hasn’t been indexed for Find Me yet — ask an admin to run indexing.');
        setPhase('pick');
      } else {
        setError(e instanceof Error ? e.message : 'Search failed');
        setPhase('pick');
      }
    }
  }

  async function sendFeedback(
    photoId: string,
    verdict: 'not_me' | 'confirmed',
    runId?: string,
  ): Promise<void> {
    const body: FeedbackRequest = {
      eventId,
      photoId,
      verdict,
      ...(runId !== undefined ? { runId } : {}),
    };
    await apiPost('/api/feedback', body);
  }

  function handleNotMe(ref: Reference, photoId: string): void {
    // Optimistic removal (B7): hide immediately, drop from selection, then post.
    setReferences((prev) =>
      prev.map((r) => (r.id === ref.id ? { ...r, hidden: new Set(r.hidden).add(photoId) } : r)),
    );
    if (sel.isSelected(photoId)) sel.toggle(photoId);
    sendFeedback(photoId, 'not_me', ref.runId).catch(() => {
      // Revert on failure so the UI doesn't silently lose a real match.
      setReferences((prev) =>
        prev.map((r) => (r.id === ref.id ? { ...r, hidden: withRemoved(r.hidden, photoId) } : r)),
      );
      setError('Could not record that feedback — please try again.');
    });
  }

  function handleConfirm(ref: Reference, photoId: string): void {
    setConfirmed((prev) => new Set(prev).add(photoId));
    void sendFeedback(photoId, 'confirmed', ref.runId).catch(() => undefined);
  }

  async function downloadSelected(): Promise<void> {
    if (sel.count === 0) return;
    setDownloading(true);
    setError(null);
    try {
      const body: DownloadRequest = { photoIds: [...sel.selected] };
      await apiDownloadFile(
        `/api/events/${encodeURIComponent(eventId)}/download`,
        body,
        'my-photos.zip',
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Download failed');
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div>
      <div className="gallery-header">
        <h2>Find Me</h2>
        <Link to={`/events/${eventId}`} className="btn btn-light">
          ← Back to gallery
        </Link>
      </div>

      {phase === 'consent' && (
        <div className="consent-card">
          <h3>Before we search</h3>
          <p>
            Find Me compares a photo of you against this event&rsquo;s photos using face
            matching. Your reference photo is used only for this search.
          </p>
          <label className="consent-row">
            <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
            <span>
              I consent to the use of my photo for face matching in this event, and I am
              searching for myself (or as the guardian of the person pictured).
            </span>
          </label>
          <button className="btn btn-primary" disabled={!agreed} onClick={() => setPhase('pick')}>
            Continue
          </button>
        </div>
      )}

      {phase === 'pick' && (
        <div className="consent-card">
          <h3>{references.length > 0 ? 'Add another photo' : 'Upload a photo of yourself'}</h3>
          <p className="muted">A clear, front-facing photo works best — a selfie is perfect.</p>
          {error && <p className="error-text">{error}</p>}
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            capture="user"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void search(f);
            }}
          />
          <button className="btn btn-primary" onClick={() => fileInput.current?.click()}>
            Choose / take a photo
          </button>
          {references.length > 0 && (
            <button className="btn btn-light" onClick={() => setPhase('results')}>
              Cancel
            </button>
          )}
        </div>
      )}

      {phase === 'searching' && <p className="muted">Searching the event photos…</p>}

      {phase === 'results' && (
        <div>
          {references.length > 1 && (
            <div className="ref-picker" role="tablist" aria-label="Reference photos">
              {references.map((r) => (
                <button
                  key={r.id}
                  role="tab"
                  aria-selected={activeId === r.id}
                  className={`ref-tab${activeId === r.id ? ' active' : ''}`}
                  onClick={() => setActiveId(r.id)}
                  title={r.label}
                >
                  <img src={r.previewUrl} alt={r.label} />
                  <span>{r.label}</span>
                </button>
              ))}
              <button
                role="tab"
                aria-selected={isCombined}
                className={`ref-tab ref-combined${isCombined ? ' active' : ''}`}
                onClick={() => setActiveId(COMBINED)}
              >
                <span>★ Combined</span>
              </button>
            </div>
          )}

          {references.length === 1 && activeRef && (
            <div className="ref-current">
              <img src={activeRef.previewUrl} alt="Your reference photo" />
              <span className="muted">Results for this photo</span>
            </div>
          )}

          {error && <p className="error-text">{error}</p>}

          {visible.length === 0 ? (
            <p className="muted">
              {isCombined
                ? 'No matches yet.'
                : 'No matches for this photo (or you removed them all).'}{' '}
              Try the{' '}
              <Link to={`/events/${eventId}`}>full gallery</Link> or add another photo.
            </p>
          ) : (
            <>
              <p className="muted">
                {isCombined
                  ? `${visible.length} matches across your photos, best first.`
                  : `${visible.length} possible matches, best first.`}{' '}
                Tap to select, then download the originals.
              </p>
              <SelectBar
                total={ids.length}
                selectedCount={sel.count}
                busy={downloading}
                onSelectAll={sel.selectAll}
                onSelectNone={sel.selectNone}
                onInvert={sel.invert}
                onDownload={() => void downloadSelected()}
              />
              <div className="photo-grid">
                {visible.map((r) => {
                  const checked = sel.isSelected(r.photoId);
                  return (
                    <div key={r.photoId} className={`result-cell${checked ? ' selected' : ''}`}>
                      <button
                        className="result-thumb"
                        aria-pressed={checked}
                        onClick={() => sel.toggle(r.photoId)}
                      >
                        <img src={r.thumbUrl} alt="" loading="lazy" />
                        <span className="score-chip">{Math.round(r.score * 100)}%</span>
                        <span className="select-tick">{checked ? '✓' : ''}</span>
                      </button>
                      {!isCombined && activeRef && (
                        <div className="feedback-row">
                          <button
                            className="btn-feedback"
                            onClick={() => handleNotMe(activeRef, r.photoId)}
                          >
                            Not me
                          </button>
                          <button
                            className={`btn-feedback${confirmed.has(r.photoId) ? ' confirmed' : ''}`}
                            onClick={() => handleConfirm(activeRef, r.photoId)}
                          >
                            {confirmed.has(r.photoId) ? '✓ Me' : "That's me"}
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}

          <button className="btn btn-light" onClick={() => setPhase('pick')}>
            + Add another photo
          </button>
        </div>
      )}
    </div>
  );
}
