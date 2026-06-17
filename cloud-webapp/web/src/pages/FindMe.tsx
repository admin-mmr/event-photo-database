import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type {
  SearchResponse,
  MatchResult,
  DownloadRequest,
  FeedbackRequest,
  ListReferencesResponse,
  ReferenceUpload,
  SearchByUploadRequest,
} from '@cloud-webapp/shared';
import {
  apiGet,
  apiUpload,
  apiPost,
  apiDownloadFile,
  apiFetchBlob,
  apiGetBlob,
  ApiError,
} from '../lib/api.js';
import { useSelection } from '../lib/selection.js';
import { combineReferences, visibleResults } from '../lib/results.js';
import { saveToPhone } from '../lib/share.js';
import { savePhotosIndividually, type NamedBlob } from '../lib/downloads.js';
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
  const [isMinor, setIsMinor] = useState(false);
  const [guardianOk, setGuardianOk] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // When a reference has no detectable face we hold it here to offer an
  // outfit-only retry (FR-7) without making the user re-pick the file.
  const [noFaceFile, setNoFaceFile] = useState<File | null>(null);
  const [references, setReferences] = useState<Reference[]>([]);
  const [activeId, setActiveId] = useState<string>(COMBINED);
  const [confirmed, setConfirmed] = useState<Set<string>>(new Set());
  const [downloading, setDownloading] = useState(false);
  const [saving, setSaving] = useState(false);
  // Past reference selfies the user can reuse to search this event (D7/FR-10b).
  const [pastUploads, setPastUploads] = useState<ReferenceUpload[] | null>(null);
  const [selectedPast, setSelectedPast] = useState<Set<string>>(new Set());
  const fileInput = useRef<HTMLInputElement>(null);

  // Consent can't be given for a minor without guardian attestation (PRD §8.3).
  const consentOk = agreed && (!isMinor || guardianOk);
  const canSavePhotos = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

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

  // Load the user's reusable past selfies the first time they reach "pick".
  useEffect(() => {
    if (phase === 'pick') void loadPastUploads();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  /** Append a result set from a search response and make it the active tab. */
  function pushReference(res: SearchResponse, previewUrl: string, labelPrefix: string): void {
    const id = res.runId ?? crypto.randomUUID();
    setReferences((prev) => [
      ...prev,
      {
        id,
        previewUrl,
        label: `${labelPrefix} ${prev.length + 1}`,
        ...(res.runId !== undefined ? { runId: res.runId } : {}),
        mode: res.mode,
        results: res.results,
        hidden: new Set(),
      },
    ]);
    setActiveId(id);
  }

  async function loadPastUploads(force = false): Promise<void> {
    if (pastUploads !== null && !force) return;
    try {
      const res = await apiGet<ListReferencesResponse>('/api/findme/uploads');
      setPastUploads(res.uploads);
    } catch {
      // Non-fatal: if history can't load we just don't show the reuse section.
      setPastUploads([]);
    }
  }

  function togglePast(uploadId: string): void {
    setSelectedPast((prev) => {
      const next = new Set(prev);
      if (next.has(uploadId)) next.delete(uploadId);
      else next.add(uploadId);
      return next;
    });
  }

  async function searchByUpload(u: ReferenceUpload): Promise<void> {
    const body: SearchByUploadRequest = {
      eventId,
      ...(u.mode === 'person' ? { mode: 'person' as const } : {}),
      subjectIsMinor: isMinor,
      guardianAttested: guardianOk,
    };
    const res = await apiPost<SearchResponse, SearchByUploadRequest>(
      `/api/findme/uploads/${encodeURIComponent(u.uploadId)}/search`,
      body,
    );
    pushReference(res, u.url, 'Saved');
  }

  async function runSelectedPast(): Promise<void> {
    const chosen = (pastUploads ?? []).filter((u) => selectedPast.has(u.uploadId));
    if (chosen.length === 0) return;
    setPhase('searching');
    setError(null);
    try {
      // Sequential: each stored photo produces its own result set (FR-9), and
      // serial calls keep us under the per-user search rate limit.
      for (const u of chosen) {
        // eslint-disable-next-line no-await-in-loop
        await searchByUpload(u);
      }
      setSelectedPast(new Set());
      setPhase('results');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'guardian_required') setPhase('consent');
      else setPhase('pick');
      setError(e instanceof Error ? e.message : 'Search failed');
    }
  }

  async function search(file: File, mode: 'fused' | 'person' = 'fused'): Promise<void> {
    setPhase('searching');
    setError(null);
    setNoFaceFile(null);
    const form = new FormData();
    form.set('file', file);
    form.set('eventId', eventId);
    form.set('consent', 'true');
    form.set('subjectIsMinor', String(isMinor));
    form.set('guardianAttested', String(guardianOk));
    if (mode === 'person') form.set('mode', 'person');
    try {
      const res = await apiUpload<SearchResponse>('/api/findme/search', form);
      pushReference(res, URL.createObjectURL(file), mode === 'person' ? 'Outfit' : 'Photo');
      setPhase('results');
      // Refresh history so this just-uploaded photo appears in the reuse picker.
      void loadPastUploads(true);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'no_usable_face') {
        // FR-7: keep the file and offer an outfit/appearance-only retry.
        setNoFaceFile(file);
        setError(
          'We couldn’t find a clear face in that photo. You can search by outfit and appearance instead, or try a sharper, front-facing picture.',
        );
        setPhase('pick');
      } else if (e instanceof ApiError && e.code === 'guardian_required') {
        setError(e.message);
        setPhase('consent');
      } else if (e instanceof ApiError && e.code === 'event_not_indexed') {
        setError('This event hasn’t been indexed for Find Me yet — ask an admin to run indexing.');
        setPhase('pick');
      } else if (e instanceof ApiError && e.code === 'rate_limited') {
        setError(e.message);
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

  async function downloadIndividual(): Promise<void> {
    if (sel.count === 0) return;
    setDownloading(true);
    setError(null);
    try {
      const ids = [...sel.selected];
      const files: NamedBlob[] = [];
      for (const photoId of ids) {
        const blob = await apiGetBlob(
          `/api/events/${encodeURIComponent(eventId)}/photos/${encodeURIComponent(photoId)}/original`,
        );
        files.push({ blob, filename: `${photoId}.jpg` });
      }
      await savePhotosIndividually(files, { title: 'My event photos' });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Download failed');
    } finally {
      setDownloading(false);
    }
  }

  async function saveSelected(): Promise<void> {
    if (sel.count === 0) return;
    setSaving(true);
    setError(null);
    try {
      const body: DownloadRequest = { photoIds: [...sel.selected] };
      const blob = await apiFetchBlob(`/api/events/${encodeURIComponent(eventId)}/download`, body);
      // Hands the ZIP to the native share sheet ("Save to Files/Photos"); on
      // browsers without Web Share L2 this falls back to a download (FR-13).
      await saveToPhone(blob, 'my-photos.zip', { title: 'My event photos' });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save photos');
    } finally {
      setSaving(false);
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
          {error && <p className="error-text">{error}</p>}
          <label className="consent-row">
            <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
            <span>
              I consent to the use of this photo for face matching in this event.
            </span>
          </label>
          <label className="consent-row">
            <input
              type="checkbox"
              checked={isMinor}
              onChange={(e) => {
                setIsMinor(e.target.checked);
                if (!e.target.checked) setGuardianOk(false);
              }}
            />
            <span>The person in the photo is under 18.</span>
          </label>
          {isMinor && (
            <label className="consent-row consent-guardian">
              <input
                type="checkbox"
                checked={guardianOk}
                onChange={(e) => setGuardianOk(e.target.checked)}
              />
              <span>
                I am the parent or legal guardian of this child and I consent to this search on
                their behalf.
              </span>
            </label>
          )}
          <button className="btn btn-primary" disabled={!consentOk} onClick={() => { setError(null); setPhase('pick'); }}>
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
          {noFaceFile && (
            <button className="btn btn-light" onClick={() => void search(noFaceFile, 'person')}>
              Search by outfit instead
            </button>
          )}
          {references.length > 0 && (
            <button className="btn btn-light" onClick={() => setPhase('results')}>
              Cancel
            </button>
          )}

          {pastUploads && pastUploads.length > 0 && (
            <div className="past-uploads">
              <h4>Or reuse a previous photo</h4>
              <p className="muted">Pick one or more photos you uploaded before to match this event.</p>
              <div className="past-grid">
                {pastUploads.map((u) => {
                  const checked = selectedPast.has(u.uploadId);
                  return (
                    <button
                      key={u.uploadId}
                      className={`past-cell${checked ? ' selected' : ''}`}
                      aria-pressed={checked}
                      onClick={() => togglePast(u.uploadId)}
                      title={u.mode === 'person' ? 'Outfit match' : 'Face match'}
                    >
                      <img src={u.url} alt="A photo you uploaded before" loading="lazy" />
                      <span className="select-tick">{checked ? '✓' : ''}</span>
                    </button>
                  );
                })}
              </div>
              <button
                className="btn btn-primary"
                disabled={selectedPast.size === 0}
                onClick={() => void runSelectedPast()}
              >
                Match this event with selected ({selectedPast.size})
              </button>
            </div>
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
                busy={downloading || saving}
                canSave={canSavePhotos}
                onSelectAll={sel.selectAll}
                onSelectNone={sel.selectNone}
                onInvert={sel.invert}
                onDownload={() => void downloadSelected()}
                onDownloadIndividual={() => void downloadIndividual()}
                onSaveToPhone={() => void saveSelected()}
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
