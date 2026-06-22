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
import { canShareImageFiles } from '../lib/share.js';
import { downloadOriginalsZip } from '../lib/zipDownload.js';
import { reportClientError } from '../lib/reportError.js';
import { type ShareOutcome } from '../lib/share.js';
import { saveResults, loadResults, clearResults } from '../lib/findmeCache.js';
import { useFindMePageSize, FINDME_PAGE_SIZE_OPTIONS } from '../lib/pageSize.js';
import { SelectBar } from '../components/SelectBar.js';
import { Lightbox } from '../components/Lightbox.js';
import { PageSizeSelect } from '../components/PageSizeSelect.js';
import { Pager } from '../components/Pager.js';

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
  // Required: Find Me is open to guests, so we capture who is searching (feeds
  // the admin alert). Entered once here and sent on every search this session.
  const [name, setName] = useState('');
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

  // A non-empty name is required, alongside consent. Consent can't be given for
  // a minor without guardian attestation (PRD §8.3).
  const nameOk = name.trim().length > 0;
  const consentOk = agreed && nameOk && (!isMinor || guardianOk);
  // Tells the user exactly why "Continue" is disabled (the first unmet
  // requirement), so a greyed-out button is never unexplained.
  const consentHint = !nameOk
    ? 'Enter your name to continue. · 请填写姓名后继续。'
    : !agreed
      ? 'Tick the consent box to continue. · 请勾选同意框后继续。'
      : isMinor && !guardianOk
        ? 'Confirm guardian consent to continue. · 请确认监护人同意后继续。'
        : null;
  // Real file-share capability (not just `navigator.share`, which can exist
  // without file support). When false we still offer a non-ZIP "Save photos"
  // fallback so a phone is never left with only the ZIP download.
  const canSavePhotos = canShareImageFiles();

  const activeRef = references.find((r) => r.id === activeId);
  const isCombined = activeId === COMBINED || !activeRef;

  const visible = useMemo<MatchResult[]>(() => {
    if (references.length === 0) return [];
    if (isCombined) return combineReferences(references);
    return activeRef ? visibleResults(activeRef) : [];
  }, [references, isCombined, activeRef]);

  // Matcher results come back as one ranked list (no server cursor), so we page
  // the *display* client-side into discrete numbered pages. "Select all" acts on
  // the CURRENT page only (pageIds), so each download is one batch that stays
  // within MAX_DOWNLOAD_PHOTOS — someone in hundreds of photos grabs them page
  // by page. Find Me's page sizes are capped at that download limit.
  const { pageSize, setPageSize } = useFindMePageSize();
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(visible.length / pageSize));
  const shown = useMemo(
    () => visible.slice(page * pageSize, page * pageSize + pageSize),
    [visible, page, pageSize],
  );
  const rangeStart = visible.length === 0 ? 0 : page * pageSize + 1;
  const rangeEnd = Math.min(visible.length, (page + 1) * pageSize);

  // Selection is scoped to the visible page: selecting "all" never exceeds one
  // downloadable batch, and switching page starts a fresh selection.
  const pageIds = useMemo(() => shown.map((r) => r.photoId), [shown]);
  const sel = useSelection(pageIds);

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

  // Reset to the first page when the page size changes or the user switches
  // reference tabs (a different result set should start from the top).
  useEffect(() => {
    setPage(0);
  }, [pageSize, activeId]);

  // Keep the page in range if the result set shrinks (e.g. "Not me" removals).
  useEffect(() => {
    if (page > pageCount - 1) setPage(pageCount - 1);
  }, [page, pageCount]);

  // Clear the selection when switching reference tabs OR changing page —
  // selection is per-page (no cross-upload or cross-page blending), so each
  // download is one self-contained batch.
  useEffect(() => {
    sel.selectNone();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, page]);

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

  // Close the lightbox if its target scrolls out of the current page (e.g.
  // after "Not me" removes it, or switching reference tabs / pages). The
  // lightbox is scoped to the current page, so it indexes into `shown`.
  useEffect(() => {
    if (lightboxIndex !== null && lightboxIndex >= shown.length) {
      setLightboxIndex(shown.length > 0 ? shown.length - 1 : null);
    }
  }, [shown.length, lightboxIndex]);

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
      name: name.trim(),
      ...(u.mode === 'person' ? { mode: 'person' as const } : {}),
      subjectIsMinor: isMinor,
      guardianAttested: guardianOk,
    };
    const res = await apiPost<SearchResponse, SearchByUploadRequest>(
      `/api/findme/uploads/${encodeURIComponent(u.uploadId)}/search`,
      body,
    );
    pushReference(res, u.url, 'Saved · 已存');
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
      setError(e instanceof Error ? e.message : 'Search failed · 搜索失败');
    }
  }

  async function search(file: File, mode: 'fused' | 'person' = 'fused'): Promise<void> {
    setPhase('searching');
    setError(null);
    setNoFaceFile(null);
    const form = new FormData();
    form.set('file', file);
    form.set('eventId', eventId);
    form.set('name', name.trim());
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
      pushReference(res, URL.createObjectURL(file), mode === 'person' ? 'Outfit · 服装' : 'Photo · 照片');
      setPhase('results');
      // Refresh history so this just-uploaded photo appears in the reuse picker.
      void loadPastUploads(true);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'no_usable_face') {
        // FR-7: keep the file and offer an outfit/appearance-only retry.
        setNoFaceFile(file);
        setError(
          'We couldn’t find a clear face in that photo. You can search by outfit and appearance instead, or try a sharper, front-facing picture. · 这张照片中没有找到清晰的人脸。您可以改用服装和外观搜索，或换一张更清晰的正面照片。',
        );
        setPhase('pick');
      } else if (e instanceof ApiError && e.code === 'guardian_required') {
        setError(e.message);
        setPhase('consent');
      } else if (e instanceof ApiError && e.code === 'event_not_indexed') {
        setError(
          'This event hasn’t been indexed for Find Me yet — ask an admin to run indexing. · 本次活动尚未为「找到我」建立索引，请联系管理员运行索引。',
        );
        setPhase('pick');
      } else if (e instanceof ApiError && e.code === 'rate_limited') {
        setError(e.message);
        setPhase('pick');
      } else {
        setError(e instanceof Error ? e.message : 'Search failed · 搜索失败');
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
      setError('Could not record that feedback — please try again. · 无法记录此反馈，请重试。');
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
      const skipped =
        failed > 0 ? ` (${failed} couldn't be loaded and were skipped · ${failed} 张无法加载，已跳过)` : '';
      setStatus(
        `Downloaded ${included} photo${included === 1 ? '' : 's'} as a ZIP.${skipped} · 已将 ${included} 张照片打包为 ZIP 下载。`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Download failed · 下载失败');
    } finally {
      setDownloading(false);
    }
  }

  function reportSave(outcome: ShareOutcome, count: number, failed = 0): void {
    const photos = `${count} photo${count === 1 ? '' : 's'}`;
    const skipped =
      failed > 0 ? ` (${failed} couldn't be loaded and were skipped · ${failed} 张无法加载，已跳过)` : '';
    // 'shared' → went to the share sheet (iOS "Save to Photos"); 'cancelled' →
    // user dismissed, say nothing; otherwise it fell back to file downloads.
    if (outcome === 'shared') {
      setStatus(
        `Sent ${photos} to your share sheet — choose Save to Photos.${skipped} · 已将 ${count} 张照片发送到分享菜单，请选择「保存到照片」。`,
      );
    } else if (outcome !== 'cancelled') {
      setStatus(`Downloaded ${photos}.${skipped} · 已下载 ${count} 张照片。`);
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
      savePhotosIndividually(files, { title: 'My event photos · 我的活动照片' })
        .then((outcome) => reportSave(outcome, files.length))
        .catch((e) => setError(e instanceof Error ? e.message : 'Could not save photos · 无法保存照片'))
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
          setError(
            'Could not load any of the selected photos. Please try again in a moment. · 无法加载所选的任何照片，请稍后重试。',
          );
          return;
        }
        reportSave(
          await savePhotosIndividually(files, { title: 'My event photos · 我的活动照片' }),
          files.length,
          failed,
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not save photos · 无法保存照片');
      } finally {
        setSaving(false);
        setSaveProgress(null);
      }
    })();
  }

  return (
    <div>
      <div className="gallery-header">
        <h2>Find Me · 找到我</h2>
        <Link to={`/events/${eventId}`} className="btn btn-light">
          ← Back to gallery · 返回相册
        </Link>
      </div>

      {phase === 'consent' && (
        <div className="consent-card">
          <h3>Before we search · 搜索前须知</h3>
          <p>
            Find Me compares a photo of you against this event&rsquo;s photos using face
            matching. Your reference photo is used only for this search.
          </p>
          <p className="muted">
            找到我会使用人脸匹配，将您的照片与本次活动的照片进行比对。您的参考照片仅用于本次搜索。
          </p>
          {error && <p className="error-text">{error}</p>}
          <label className="consent-row consent-name">
            <span>Your name (required) · 您的姓名（必填）</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Jamie Lee · 例如：张三"
              maxLength={120}
              autoComplete="name"
              required
              aria-required="true"
            />
            <span className="field-hint muted">
              Required. Shown to event organizers so they know who searched. · 必填。此姓名会提供给活动主办方，以便了解是谁进行了搜索。
            </span>
          </label>
          <label className="consent-row">
            <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
            <span>
              I consent to the use of this photo for face matching in this event. · 我同意将此照片用于本次活动的人脸匹配。
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
            <span>The person in the photo is under 18. · 照片中的人未满 18 岁。</span>
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
                their behalf. · 我是该儿童的父母或法定监护人，并代表其同意本次搜索。
              </span>
            </label>
          )}
          {!consentOk && consentHint && (
            <p className="field-hint muted" role="status">
              {consentHint}
            </p>
          )}
          <button className="btn btn-primary" disabled={!consentOk} onClick={() => { setError(null); setPhase('pick'); }}>
            Continue · 继续
          </button>
        </div>
      )}

      {phase === 'pick' && (
        <div className="consent-card">
          <h3>
            {references.length > 0
              ? 'Add another photo · 添加另一张照片'
              : 'Upload a photo of yourself · 上传您的照片'}
          </h3>
          <p className="muted">
            A clear, front-facing photo works best — a selfie is perfect. · 清晰的正面照片效果最佳，自拍即可。
          </p>
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
            Choose / take a photo · 选择或拍摄照片
          </button>
          {noFaceFile && (
            <button className="btn btn-light" onClick={() => void search(noFaceFile, 'person')}>
              Search by outfit instead · 改用服装搜索
            </button>
          )}
          {/* Standard (face) vs outfit search, so people understand the choice —
              especially after a "no clear face" fallback is offered. */}
          <div className="mode-note muted">
            <p>
              <strong>Standard search · 标准搜索</strong> uses your face — most accurate, but it
              needs a clear, front-facing photo. · 使用人脸匹配，最准确，但需要清晰的正面照片。
            </p>
            <p>
              <strong>Search by outfit · 服装搜索</strong> matches your clothing and overall
              appearance instead of your face — useful when no clear face is found, but only
              reliable within this event. · 根据您的衣着和整体外观（而非面部）进行匹配，在找不到清晰人脸时很有用，但仅在本次活动内可靠。
            </p>
          </div>
          {references.length > 0 && (
            <button className="btn btn-light" onClick={() => setPhase('results')}>
              Cancel · 取消
            </button>
          )}

          {pastUploads && pastUploads.length > 0 && (
            <div className="past-uploads">
              <h4>Or reuse a previous photo · 或重复使用以前的照片</h4>
              <p className="muted">
                Pick one or more photos you uploaded before to match this event. · 选择一张或多张您之前上传的照片来匹配本次活动。
              </p>
              <div className="past-grid">
                {pastUploads.map((u) => {
                  const checked = selectedPast.has(u.uploadId);
                  return (
                    <button
                      key={u.uploadId}
                      className={`past-cell${checked ? ' selected' : ''}`}
                      aria-pressed={checked}
                      onClick={() => togglePast(u.uploadId)}
                      title={u.mode === 'person' ? 'Outfit match · 服装匹配' : 'Face match · 人脸匹配'}
                    >
                      <img src={u.url} alt="A photo you uploaded before · 您之前上传的照片" loading="lazy" />
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
                Match this event with selected ({selectedPast.size}) · 用所选照片匹配（{selectedPast.size}）
              </button>
            </div>
          )}
        </div>
      )}

      {phase === 'searching' && (
        <div className="searching" role="status" aria-live="polite">
          <span className="spinner" aria-hidden="true" />
          <div>
            <p className="searching-title">Searching the event photos… · 正在搜索活动照片…</p>
            <p className="muted">
              The first search can take a few seconds to warm up. · 首次搜索可能需要几秒钟来预热。
            </p>
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
                <span>★ Combined · 合并</span>
              </button>
            </div>
          )}

          {references.length === 1 && activeRef && (
            <div className="ref-current">
              {activeRef.previewUrl && (
                <img src={activeRef.previewUrl} alt="Your reference photo · 您的参考照片" />
              )}
              <span className="muted">Results for this photo · 此照片的匹配结果</span>
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
                ? 'No matches yet. · 暂无匹配结果。'
                : 'No matches for this photo (or you removed them all). · 此照片没有匹配结果（或已全部移除）。'}{' '}
              Try the{' '}
              <Link to={`/events/${eventId}`}>full gallery · 完整相册</Link> or add another photo. · 可浏览完整相册或添加另一张照片。
            </p>
          ) : (
            <>
              <div className="results-toolbar">
                <p className="muted results-count">
                  {isCombined
                    ? `${visible.length} matches across your photos, best first. · 您的照片共匹配到 ${visible.length} 张，按相似度排序。`
                    : `${visible.length} possible matches, best first. · 共 ${visible.length} 张可能匹配，按相似度排序。`}{' '}
                  Tap a photo to enlarge and check it&rsquo;s you; tick the box to select, then
                  download the originals. · 点按照片可放大确认是否是您；勾选方框选中后即可下载原图。
                </p>
                {visible.length > FINDME_PAGE_SIZE_OPTIONS[0] && (
                  <PageSizeSelect
                    value={pageSize}
                    onChange={setPageSize}
                    label="Matches per page · 每页匹配数"
                    options={FINDME_PAGE_SIZE_OPTIONS}
                  />
                )}
              </div>
              {pageCount > 1 && (
                <p className="muted batch-hint">
                  Showing {rangeStart}–{rangeEnd} of {visible.length}. “Select page” selects only this
                  page — download one page at a time. · 正在显示第 {rangeStart}–{rangeEnd} 张，共{' '}
                  {visible.length} 张。"选择本页"仅选中本页——请逐页下载。
                </p>
              )}
              <SelectBar
                total={pageIds.length}
                selectedCount={sel.count}
                busy={downloading || saving}
                saveProgress={
                  savePreparing ? { done: preparedCount, total: sel.count } : saveProgress
                }
                savePreparing={savePreparing}
                canSave={canSavePhotos}
                selectAllLabel="Select page · 选择本页"
                onSelectAll={sel.selectAll}
                onSelectNone={sel.selectNone}
                onInvert={sel.invert}
                onDownload={() => void downloadSelected()}
                onSaveToPhone={() => saveSelected()}
                {...(canSavePhotos ? {} : { onDownloadIndividual: () => saveSelected() })}
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
                            Not me · 不是我
                          </button>
                          <button
                            className={`btn-feedback${confirmed.has(r.photoId) ? ' confirmed' : ''}`}
                            onClick={() => handleConfirm(activeRef, r.photoId)}
                          >
                            {confirmed.has(r.photoId) ? '✓ Me · 是我' : "That's me · 是我"}
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              <Pager page={page} pageCount={pageCount} onChange={setPage} />
            </>
          )}

          <button className="btn btn-light" onClick={() => setPhase('pick')}>
            + Add another photo · 添加另一张照片
          </button>

          {lightboxIndex !== null && shown[lightboxIndex] && (
            <Lightbox
              items={shown.map((r) => {
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
                      {checked ? '✓ Selected · 已选中' : 'Select · 选择'}
                    </button>
                    {!isCombined && activeRef && (
                      <>
                        <button
                          className="btn btn-light btn-sm"
                          onClick={() => handleNotMe(activeRef, item.key)}
                        >
                          Not me · 不是我
                        </button>
                        <button
                          className={`btn btn-sm ${confirmed.has(item.key) ? 'btn-primary' : 'btn-light'}`}
                          onClick={() => handleConfirm(activeRef, item.key)}
                        >
                          {confirmed.has(item.key) ? '✓ Me · 是我' : "That's me · 是我"}
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
