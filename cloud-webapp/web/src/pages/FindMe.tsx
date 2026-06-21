import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type {
  SearchResponse,
  MatchResult,
  FeedbackRequest,
  ListReferencesResponse,
  ReferenceUpload,
  SearchByUploadRequest,
} from '@cloud-webapp/shared';
import {
  apiGet,
  apiUpload,
  apiPost,
  apiGetBlob,
  ApiError,
} from '../lib/api.js';
import { getRecaptchaToken } from '../lib/recaptcha.js';
import { useSelection } from '../lib/selection.js';
import { combineReferences, visibleResults, scoreBand, bandLabel } from '../lib/results.js';
import { savePhotosIndividually, type NamedBlob } from '../lib/downloads.js';
import { downloadOriginalsZip } from '../lib/zipDownload.js';
import { reportClientError } from '../lib/reportError.js';
import { type ShareOutcome } from '../lib/share.js';
import { saveResults, loadResults, clearResults } from '../lib/findmeCache.js';
import { usePageSize, PAGE_SIZE_OPTIONS } from '../lib/pageSize.js';
import { SelectBar } from '../components/SelectBar.js';
import { Lightbox } from '../components/Lightbox.js';
import { PageSizeSelect } from '../components/PageSizeSelect.js';
import { LoadMore } from '../components/LoadMore.js';

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
  // Save-to-Photos progress (C9): how many originals have been fetched so far.
  const [saveProgress, setSaveProgress] = useState<{ done: number; total: number } | null>(null);
  // Original blobs cached per photo for "Save to Photos". iOS only honours
  // navigator.share inside the tap's transient activation, so we must NOT await
  // a network fetch before sharing — we prefetch the selected originals here and
  // share synchronously once they're cached. The ref mirrors the state so the
  // prefetch effect can skip cached ids without depending on origBlobs.
  const [origBlobs, setOrigBlobs] = useState<Record<string, Blob>>({});
  const origBlobsRef = useRef<Record<string, Blob>>({});
  const origFetching = useRef<Set<string>>(new Set());
  // Transient success line after a save/download (C9), announced via aria-live.
  const [status, setStatus] = useState<string | null>(null);
  // Index into `visible` of the photo open in the lightbox, or null (C4/C5).
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  // Past reference selfies the user can reuse to search this event (D7/FR-10b).
  const [pastUploads, setPastUploads] = useState<ReferenceUpload[] | null>(null);
  const [selectedPast, setSelectedPast] = useState<Set<string>>(new Set());
  const fileInput = useRef<HTMLInputElement>(null);
  // Set once we've attempted to restore cached results, so the save effect
  // doesn't overwrite the cache before the restore has run (C6).
  const restored = useRef(false);

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

  // Stable key for the selected set so prefetch/prune effects only re-run when
  // the set changes, not every render.
  const selectedKey = useMemo(() => [...sel.selected].sort().join(','), [sel.selected]);
  // All selected originals cached → the batch share can fire synchronously.
  const selectedReady = sel.count > 0 && [...sel.selected].every((id) => Boolean(origBlobs[id]));
  // On mobile, true while we're still prefetching selected originals (the Save
  // button shows "Preparing…" and stays disabled until they're all in hand).
  const savePreparing = canSavePhotos && sel.count > 0 && !selectedReady;
  const preparedCount = useMemo(
    () => [...sel.selected].filter((id) => Boolean(origBlobs[id])).length,
    [sel.selected, origBlobs],
  );

  // Matcher results come back as one ranked list (no server cursor), so we
  // page the *display* client-side: show `visibleCount`, governed by the same
  // page-size preference as the gallery, with a "Load more" affordance. Keeps
  // the initial render light on phones when there are lots of matches.
  const { pageSize, setPageSize } = usePageSize();
  const [visibleCount, setVisibleCount] = useState(pageSize);
  const shown = useMemo(() => visible.slice(0, visibleCount), [visible, visibleCount]);

  // Reset the window when the page size changes or the user switches reference
  // tabs (a different result set should start from the top).
  useEffect(() => {
    setVisibleCount(pageSize);
  }, [pageSize, activeId]);

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

  // C6: restore cached results on mount so a reload (or the iOS share/download
  // bounce) doesn't wipe the matches and force a re-search. Runs once.
  useEffect(() => {
    const cached = loadResults(eventId);
    if (cached && cached.references.length > 0) {
      setReferences(cached.references);
      setActiveId(cached.activeId);
      setConfirmed(cached.confirmed);
      setPhase('results');
    }
    restored.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId]);

  // C6: persist whenever the result set changes (after the initial restore).
  // Clear the cache once everything is gone.
  useEffect(() => {
    if (!restored.current) return;
    if (references.length > 0) saveResults(eventId, { references, activeId, confirmed });
    else clearResults(eventId);
  }, [eventId, references, activeId, confirmed]);

  // Close the lightbox if its target scrolls out of the current result set
  // (e.g. after "Not me" removes it, or switching reference tabs).
  useEffect(() => {
    if (lightboxIndex !== null && lightboxIndex >= visible.length) {
      setLightboxIndex(visible.length > 0 ? visible.length - 1 : null);
    }
  }, [visible.length, lightboxIndex]);

  // Prefetch selected originals (mobile only) so the batch "Save to Photos" can
  // share synchronously inside the tap. Reads the ref to skip cached ids, so
  // adding a blob doesn't re-fire; re-runs only when the selected set changes.
  useEffect(() => {
    if (!canSavePhotos) return;
    for (const id of sel.selected) {
      if (origBlobsRef.current[id] || origFetching.current.has(id)) continue;
      origFetching.current.add(id);
      apiGetBlob(`/api/events/${encodeURIComponent(eventId)}/photos/${encodeURIComponent(id)}/original`)
        .then((blob) => {
          origBlobsRef.current = { ...origBlobsRef.current, [id]: blob };
          setOrigBlobs(origBlobsRef.current);
        })
        .catch(() => {
          /* leave uncached; the save falls back to a download for this one */
        })
        .finally(() => origFetching.current.delete(id));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canSavePhotos, selectedKey]);

  // Drop cached originals no longer selected (bounds mobile memory). Keyed on
  // the selected set so it runs when the selection shrinks or switches tabs.
  useEffect(() => {
    let changed = false;
    for (const id of Object.keys(origBlobsRef.current)) {
      if (sel.isSelected(id)) continue;
      const next = { ...origBlobsRef.current };
      delete next[id];
      origBlobsRef.current = next;
      changed = true;
    }
    if (changed) setOrigBlobs(origBlobsRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey]);

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
      const recaptchaToken = await getRecaptchaToken('findme_search');
      const res = await apiUpload<SearchResponse>(
        '/api/findme/search',
        form,
        recaptchaToken ? { headers: { 'X-Recaptcha-Token': recaptchaToken } } : undefined,
      );
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
    setStatus(null);
    try {
      const { included, failed } = await downloadOriginalsZip(
        eventId,
        [...sel.selected],
        'my-photos.zip',
      );
      const skipped = failed > 0 ? ` (${failed} couldn't be loaded and were skipped)` : '';
      setStatus(`Downloaded ${included} photo${included === 1 ? '' : 's'} as a ZIP.${skipped}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Download failed');
    } finally {
      setDownloading(false);
    }
  }

  function reportSave(outcome: ShareOutcome, count: number, failed = 0): void {
    const photos = `${count} photo${count === 1 ? '' : 's'}`;
    const skipped = failed > 0 ? ` (${failed} couldn't be loaded and were skipped)` : '';
    // 'shared' → went to the share sheet (iOS "Save to Photos"); 'cancelled' →
    // user dismissed, say nothing; otherwise it fell back to file downloads.
    if (outcome === 'shared') {
      setStatus(`Sent ${photos} to your share sheet — choose Save to Photos.${skipped}`);
    } else if (outcome !== 'cancelled') {
      setStatus(`Downloaded ${photos}.${skipped}`);
    }
  }

  /**
   * "Save to Photos" (§5B C3). Hands the actual image FILES to the native share
   * sheet — on iOS that yields "Save N Images to Photos". A ZIP can't be expanded
   * into the iOS photo library, so we deliberately share images, not the ZIP.
   *
   * iOS only honours navigator.share while the tap's *transient activation* is
   * live, so we must NOT await a network fetch before calling it. On mobile the
   * selected originals are prefetched into `origBlobs` (the button stays disabled
   * — "Preparing…" — until they're all cached), so the fast path builds the files
   * and shares synchronously in the same tick. The fetch-then-share fallback only
   * runs on desktop, where the helper degrades to per-file downloads and
   * activation doesn't matter.
   */
  function saveSelected(): void {
    if (sel.count === 0) return;
    const ids = [...sel.selected];
    const n = ids.length;
    setError(null);
    setStatus(null);

    // Fast path: every selected original is cached → share synchronously.
    if (canSavePhotos && selectedReady) {
      const files: NamedBlob[] = ids
        .map((id) => {
          const blob = origBlobs[id];
          return blob ? { blob, filename: `${id}.jpg` } : null;
        })
        .filter((f): f is NamedBlob => f !== null);
      setSaving(true);
      savePhotosIndividually(files, { title: 'My event photos' })
        .then((outcome) => reportSave(outcome, files.length))
        .catch((e) => setError(e instanceof Error ? e.message : 'Could not save photos'))
        .finally(() => setSaving(false));
      return;
    }

    // Fallback (desktop, or a blob still loading): fetch with a small concurrency
    // pool and tolerate per-photo failures, then save/download. Slots preserve
    // order so filenames stay stable.
    void (async () => {
      setSaving(true);
      setSaveProgress({ done: 0, total: n });
      try {
        const slots: (NamedBlob | null)[] = new Array<NamedBlob | null>(n).fill(null);
        let done = 0;
        let failed = 0;
        let cursor = 0;
        const CONCURRENCY = 5;
        const worker = async (): Promise<void> => {
          while (cursor < n) {
            const i = cursor;
            cursor += 1;
            const photoId = ids[i];
            try {
              if (photoId === undefined) throw new Error('missing id');
              // eslint-disable-next-line no-await-in-loop
              const blob = await apiGetBlob(
                `/api/events/${encodeURIComponent(eventId)}/photos/${encodeURIComponent(photoId)}/original`,
              );
              slots[i] = { blob, filename: `${photoId}.jpg` };
            } catch {
              failed += 1;
            } finally {
              done += 1;
              setSaveProgress({ done, total: n });
            }
          }
        };
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, n) }, () => worker()));

        const files = slots.filter((f): f is NamedBlob => f !== null);
        if (files.length === 0) {
          reportClientError('download_failed', 'Save to Photos: every original failed to load', {
            context: { eventId, requested: n, failed },
          });
          setError('Could not load any of the selected photos. Please try again in a moment.');
          return;
        }
        reportSave(await savePhotosIndividually(files, { title: 'My event photos' }), files.length, failed);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not save photos');
      } finally {
        setSaving(false);
        setSaveProgress(null);
      }
    })();
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

      {phase === 'searching' && (
        <div className="searching" role="status" aria-live="polite">
          <span className="spinner" aria-hidden="true" />
          <div>
            <p className="searching-title">Searching the event photos…</p>
            <p className="muted">The first search can take a few seconds to warm up.</p>
          </div>
        </div>
      )}

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
                  {r.previewUrl && <img src={r.previewUrl} alt={r.label} />}
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
              {activeRef.previewUrl && <img src={activeRef.previewUrl} alt="Your reference photo" />}
              <span className="muted">Results for this photo</span>
            </div>
          )}

          {error && <p className="error-text">{error}</p>}
          {status && (
            <p className="status-text" role="status" aria-live="polite">
              {status}
            </p>
          )}

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
              <div className="results-toolbar">
                <p className="muted results-count">
                  {isCombined
                    ? `${visible.length} matches across your photos, best first.`
                    : `${visible.length} possible matches, best first.`}{' '}
                  Tap a photo to enlarge and check it&rsquo;s you; tick the box to select, then
                  download the originals.
                </p>
                {visible.length > PAGE_SIZE_OPTIONS[0] && (
                  <PageSizeSelect value={pageSize} onChange={setPageSize} label="Matches per page" />
                )}
              </div>
              <SelectBar
                total={ids.length}
                selectedCount={sel.count}
                busy={downloading || saving}
                saveProgress={
                  savePreparing ? { done: preparedCount, total: sel.count } : saveProgress
                }
                savePreparing={savePreparing}
                canSave={canSavePhotos}
                onSelectAll={sel.selectAll}
                onSelectNone={sel.selectNone}
                onInvert={sel.invert}
                onDownload={() => void downloadSelected()}
                onSaveToPhone={() => saveSelected()}
              />
              <div className="photo-grid">
                {shown.map((r, i) => {
                  const checked = sel.isSelected(r.photoId);
                  const band = scoreBand(r.score);
                  return (
                    <div key={r.photoId} className={`result-cell${checked ? ' selected' : ''}`}>
                      {/* C5: tapping the photo VIEWS it (lightbox); selection is
                          the separate checkbox so the two don't collide. */}
                      <button
                        className="result-thumb"
                        aria-label="Enlarge photo"
                        onClick={() => setLightboxIndex(i)}
                      >
                        <img src={r.thumbUrl} alt="" loading="lazy" />
                        {/* C7: confidence band (the raw % stays as detail). */}
                        <span className={`score-chip band-${band}`}>
                          {bandLabel(band)} · {Math.round(r.score * 100)}%
                        </span>
                      </button>
                      <button
                        className="select-box"
                        aria-pressed={checked}
                        aria-label={checked ? 'Deselect photo' : 'Select photo'}
                        onClick={() => sel.toggle(r.photoId)}
                      >
                        {checked ? '✓' : ''}
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
              <LoadMore
                shownCount={shown.length}
                total={visible.length}
                hasMore={shown.length < visible.length}
                loading={false}
                onLoadMore={() => setVisibleCount((c) => c + pageSize)}
                noun="match"
              />
            </>
          )}

          <button className="btn btn-light" onClick={() => setPhase('pick')}>
            + Add another photo
          </button>

          {lightboxIndex !== null && visible[lightboxIndex] && (
            <Lightbox
              items={visible.map((r) => {
                const band = scoreBand(r.score);
                return {
                  key: r.photoId,
                  src: r.webUrl,
                  alt: '',
                  badge: (
                    <span className={`score-chip band-${band}`}>
                      {bandLabel(band)} · {Math.round(r.score * 100)}%
                    </span>
                  ),
                };
              })}
              index={lightboxIndex}
              onClose={() => setLightboxIndex(null)}
              onNavigate={setLightboxIndex}
              renderFooter={(item) => {
                const checked = sel.isSelected(item.key);
                return (
                  <>
                    <button
                      className={`btn btn-sm ${checked ? 'btn-primary' : 'btn-light'}`}
                      onClick={() => sel.toggle(item.key)}
                    >
                      {checked ? '✓ Selected' : 'Select'}
                    </button>
                    {!isCombined && activeRef && (
                      <>
                        <button
                          className="btn btn-light btn-sm"
                          onClick={() => handleNotMe(activeRef, item.key)}
                        >
                          Not me
                        </button>
                        <button
                          className={`btn btn-sm ${confirmed.has(item.key) ? 'btn-primary' : 'btn-light'}`}
                          onClick={() => handleConfirm(activeRef, item.key)}
                        >
                          {confirmed.has(item.key) ? '✓ Me' : "That's me"}
                        </button>
                      </>
                    )}
                  </>
                );
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}
