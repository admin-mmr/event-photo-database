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
import { combineReferences, visibleResults, scoreBand } from '../lib/results.js';
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
import { useStrings } from '../lib/i18n.js';

const STR = {
  en: {
    enterNameHint: 'Enter your name to continue.',
    tickConsentHint: 'Tick the consent box to continue.',
    confirmGuardianHint: 'Confirm guardian consent to continue.',
    savedLabel: 'Saved',
    searchFailed: 'Search failed',
    outfitLabel: 'Outfit',
    photoLabel: 'Photo',
    noUsableFace:
      'We couldn’t find a clear face in that photo. You can search by outfit and appearance instead, or try a sharper, front-facing picture.',
    eventNotIndexed:
      'This event hasn’t been indexed for Find Me yet — ask an admin to run indexing.',
    feedbackFailed: 'Could not record that feedback — please try again.',
    downloadFailed: 'Download failed',
    downloadSkipped: (failed: number) => ` (${failed} couldn't be loaded and were skipped)`,
    downloadedZip: (included: number, skipped: string) =>
      `Downloaded ${included} photo${included === 1 ? '' : 's'} as a ZIP.${skipped}`,
    photosCount: (count: number) => `${count} photo${count === 1 ? '' : 's'}`,
    sentToShare: (photos: string, skipped: string) =>
      `Sent ${photos} to your share sheet — choose Save to Photos.${skipped}`,
    downloadedPhotos: (photos: string, skipped: string) => `Downloaded ${photos}.${skipped}`,
    shareTitle: 'My event photos',
    couldNotSavePhotos: 'Could not save photos',
    couldNotLoadAny:
      'Could not load any of the selected photos. Please try again in a moment.',
    title: 'Find Me',
    backToGallery: '← Back to gallery',
    beforeWeSearch: 'Before we search',
    consentIntro:
      'Find Me compares a photo of you against this event’s photos using face matching. Your reference photo is used only for this search.',
    consentIntroZh:
      '找到我会使用人脸匹配，将您的照片与本次活动的照片进行比对。您的参考照片仅用于本次搜索。',
    yourNameRequired: 'Your name (required)',
    namePlaceholder: 'e.g. Jamie Lee',
    nameHint: 'Required. Shown to event organizers so they know who searched.',
    consentPhoto:
      'I consent to the use of this photo for face matching in this event.',
    isMinor: 'The person in the photo is under 18.',
    guardianConsent:
      'I am the parent or legal guardian of this child and I consent to this search on their behalf.',
    continue: 'Continue',
    addAnotherPhoto: 'Add another photo',
    uploadYourself: 'Upload a photo of yourself',
    pickHint: 'A clear, front-facing photo works best — a selfie is perfect.',
    chooseTakePhoto: 'Choose / take a photo',
    searchByOutfitInstead: 'Search by outfit instead',
    standardSearch: 'Standard search',
    standardSearchDesc:
      'uses your face — most accurate, but it needs a clear, front-facing photo.',
    searchByOutfit: 'Search by outfit',
    searchByOutfitDesc:
      'matches your clothing and overall appearance instead of your face — useful when no clear face is found, but only reliable within this event.',
    cancel: 'Cancel',
    reusePrevious: 'Or reuse a previous photo',
    reuseHint:
      'Pick one or more photos you uploaded before to match this event.',
    outfitMatch: 'Outfit match',
    faceMatch: 'Face match',
    previousUploadAlt: 'A photo you uploaded before',
    matchWithSelected: (count: number) => `Match this event with selected (${count})`,
    searchingTitle: 'Searching the event photos…',
    searchingHint: 'The first search can take a few seconds to warm up.',
    referencePhotos: 'Reference photos',
    combined: '★ Combined',
    yourReferenceAlt: 'Your reference photo',
    resultsForPhoto: 'Results for this photo',
    noMatchesCombined: 'No matches yet.',
    noMatchesSingle:
      'No matches for this photo (or you removed them all).',
    tryThe: 'Try the',
    fullGallery: 'full gallery',
    orAddAnother: 'or add another photo.',
    matchesCombined: (count: number) =>
      `${count} matches across your photos, best first.`,
    matchesSingle: (count: number) => `${count} possible matches, best first.`,
    tapToEnlarge:
      'Tap a photo to enlarge and check it’s you; tick the box to select, then download the originals.',
    matchesPerPage: 'Matches per page',
    showingRange: (rangeStart: number, rangeEnd: number, total: number) =>
      `Showing ${rangeStart}–${rangeEnd} of ${total}. “Select page” selects only this page — download one page at a time.`,
    selectPage: 'Select page',
    enlargePhoto: 'Enlarge photo',
    deselectPhoto: 'Deselect photo',
    selectPhoto: 'Select photo',
    notMe: 'Not me',
    meConfirmed: '✓ Me',
    thatsMe: "That's me",
    addAnotherPhotoBtn: '+ Add another photo',
    selectedLightbox: '✓ Selected',
    select: 'Select',
    bandStrong: 'Strong',
    bandPossible: 'Possible',
  },
  zh: {
    enterNameHint: '请填写姓名后继续。',
    tickConsentHint: '请勾选同意框后继续。',
    confirmGuardianHint: '请确认监护人同意后继续。',
    savedLabel: '已存',
    searchFailed: '搜索失败',
    outfitLabel: '服装',
    photoLabel: '照片',
    noUsableFace:
      '这张照片中没有找到清晰的人脸。您可以改用服装和外观搜索，或换一张更清晰的正面照片。',
    eventNotIndexed:
      '本次活动尚未为「找到我」建立索引，请联系管理员运行索引。',
    feedbackFailed: '无法记录此反馈，请重试。',
    downloadFailed: '下载失败',
    downloadSkipped: (failed: number) => ` (${failed} 张无法加载，已跳过)`,
    downloadedZip: (included: number, skipped: string) =>
      `已将 ${included} 张照片打包为 ZIP 下载。${skipped}`,
    photosCount: (count: number) => `${count} 张照片`,
    sentToShare: (photos: string, skipped: string) =>
      `已将 ${photos} 发送到分享菜单，请选择「保存到照片」。${skipped}`,
    downloadedPhotos: (photos: string, skipped: string) => `已下载 ${photos}。${skipped}`,
    shareTitle: '我的活动照片',
    couldNotSavePhotos: '无法保存照片',
    couldNotLoadAny: '无法加载所选的任何照片，请稍后重试。',
    title: '找到我',
    backToGallery: '← 返回相册',
    beforeWeSearch: '搜索前须知',
    consentIntro:
      '找到我会使用人脸匹配，将您的照片与本次活动的照片进行比对。您的参考照片仅用于本次搜索。',
    consentIntroZh:
      '找到我会使用人脸匹配，将您的照片与本次活动的照片进行比对。您的参考照片仅用于本次搜索。',
    yourNameRequired: '您的姓名（必填）',
    namePlaceholder: '例如：张三',
    nameHint: '必填。此姓名会提供给活动主办方，以便了解是谁进行了搜索。',
    consentPhoto: '我同意将此照片用于本次活动的人脸匹配。',
    isMinor: '照片中的人未满 18 岁。',
    guardianConsent: '我是该儿童的父母或法定监护人，并代表其同意本次搜索。',
    continue: '继续',
    addAnotherPhoto: '添加另一张照片',
    uploadYourself: '上传您的照片',
    pickHint: '清晰的正面照片效果最佳，自拍即可。',
    chooseTakePhoto: '选择或拍摄照片',
    searchByOutfitInstead: '改用服装搜索',
    standardSearch: '标准搜索',
    standardSearchDesc: '使用人脸匹配，最准确，但需要清晰的正面照片。',
    searchByOutfit: '服装搜索',
    searchByOutfitDesc:
      '根据您的衣着和整体外观（而非面部）进行匹配，在找不到清晰人脸时很有用，但仅在本次活动内可靠。',
    cancel: '取消',
    reusePrevious: '或重复使用以前的照片',
    reuseHint: '选择一张或多张您之前上传的照片来匹配本次活动。',
    outfitMatch: '服装匹配',
    faceMatch: '人脸匹配',
    previousUploadAlt: '您之前上传的照片',
    matchWithSelected: (count: number) => `用所选照片匹配（${count}）`,
    searchingTitle: '正在搜索活动照片…',
    searchingHint: '首次搜索可能需要几秒钟来预热。',
    referencePhotos: '参考照片',
    combined: '★ 合并',
    yourReferenceAlt: '您的参考照片',
    resultsForPhoto: '此照片的匹配结果',
    noMatchesCombined: '暂无匹配结果。',
    noMatchesSingle: '此照片没有匹配结果（或已全部移除）。',
    tryThe: '可浏览',
    fullGallery: '完整相册',
    orAddAnother: '或添加另一张照片。',
    matchesCombined: (count: number) =>
      `您的照片共匹配到 ${count} 张，按相似度排序。`,
    matchesSingle: (count: number) => `共 ${count} 张可能匹配，按相似度排序。`,
    tapToEnlarge: '点按照片可放大确认是否是您；勾选方框选中后即可下载原图。',
    matchesPerPage: '每页匹配数',
    showingRange: (rangeStart: number, rangeEnd: number, total: number) =>
      `正在显示第 ${rangeStart}–${rangeEnd} 张，共 ${total} 张。"选择本页"仅选中本页——请逐页下载。`,
    selectPage: '选择本页',
    enlargePhoto: '放大照片',
    deselectPhoto: '取消选择照片',
    selectPhoto: '选择照片',
    notMe: '不是我',
    meConfirmed: '✓ 是我',
    thatsMe: '是我',
    addAnotherPhotoBtn: '+ 添加另一张照片',
    selectedLightbox: '✓ 已选中',
    select: '选择',
    bandStrong: '高匹配',
    bandPossible: '可能匹配',
  },
};

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
  const t = useStrings(STR);
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
  // Selected ids whose original prefetch FAILED (e.g. a CORS/network error on
  // the signed-URL blob read). These count as "settled" so the Save button
  // doesn't stay disabled on "Preparing…" forever — tapping it then runs the
  // fetch-then-share fallback in saveSelected(), which retries and tolerates
  // per-photo failures (degrading to a download where the share can't fire).
  const [prefetchFailed, setPrefetchFailed] = useState<Set<string>>(new Set());
  // Belt-and-suspenders: if a prefetch neither resolves nor rejects (a hung
  // request), stop showing "Preparing…" after this long so the button is usable.
  const [prepareTimedOut, setPrepareTimedOut] = useState(false);
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
    ? t.enterNameHint
    : !agreed
      ? t.tickConsentHint
      : isMinor && !guardianOk
        ? t.confirmGuardianHint
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
  // Every selected original has SETTLED — cached, or its prefetch failed. Once
  // settled we stop blocking the Save button (a failed prefetch must not pin it
  // on "Preparing…" forever; the tap then takes saveSelected's fetch-then-share
  // fallback path). Distinct from `selectedReady`, which gates the fast
  // synchronous share and requires every blob actually cached.
  const selectedSettled =
    sel.count > 0 &&
    [...sel.selected].every((id) => Boolean(origBlobs[id]) || prefetchFailed.has(id));
  // On mobile, true while we're still prefetching selected originals (the Save
  // button shows "Preparing…" and stays disabled until they're all in hand). It
  // clears once everything settles or the prepare watchdog times out, so the
  // button can never stay permanently disabled.
  const savePreparing =
    canSavePhotos && sel.count > 0 && !selectedSettled && !prepareTimedOut;
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
          // A retry succeeded → no longer a failed id.
          setPrefetchFailed((prev) => {
            if (!prev.has(id)) return prev;
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
        })
        .catch(() => {
          // Leave uncached and mark it settled-as-failed so the Save button
          // stops waiting; saveSelected's fallback retries + degrades to a
          // download for this one.
          setPrefetchFailed((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
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
    // Forget failures for ids no longer selected so a future re-select retries.
    setPrefetchFailed((prev) => {
      const next = new Set([...prev].filter((id) => sel.isSelected(id)));
      return next.size === prev.size ? prev : next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey]);

  // Prepare watchdog: if the prefetch hasn't settled within a few seconds (e.g.
  // a hung request that never resolves or rejects), stop showing "Preparing…"
  // so the Save button becomes tappable and falls back to fetch-then-share.
  // Reset whenever the selection changes or it does settle on its own.
  useEffect(() => {
    setPrepareTimedOut(false);
    if (!canSavePhotos || sel.count === 0 || selectedSettled) return;
    const t = setTimeout(() => setPrepareTimedOut(true), 12_000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canSavePhotos, selectedKey, selectedSettled]);

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
    pushReference(res, u.url, t.savedLabel);
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
      setError(e instanceof Error ? e.message : t.searchFailed);
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
      pushReference(res, URL.createObjectURL(file), mode === 'person' ? t.outfitLabel : t.photoLabel);
      setPhase('results');
      // Refresh history so this just-uploaded photo appears in the reuse picker.
      void loadPastUploads(true);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'no_usable_face') {
        // FR-7: keep the file and offer an outfit/appearance-only retry.
        setNoFaceFile(file);
        setError(t.noUsableFace);
        setPhase('pick');
      } else if (e instanceof ApiError && e.code === 'guardian_required') {
        setError(e.message);
        setPhase('consent');
      } else if (e instanceof ApiError && e.code === 'event_not_indexed') {
        setError(t.eventNotIndexed);
        setPhase('pick');
      } else if (e instanceof ApiError && e.code === 'rate_limited') {
        setError(e.message);
        setPhase('pick');
      } else {
        setError(e instanceof Error ? e.message : t.searchFailed);
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
      setError(t.feedbackFailed);
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
      const skipped = failed > 0 ? t.downloadSkipped(failed) : '';
      setStatus(t.downloadedZip(included, skipped));
    } catch (e) {
      setError(e instanceof Error ? e.message : t.downloadFailed);
    } finally {
      setDownloading(false);
    }
  }

  function reportSave(outcome: ShareOutcome, count: number, failed = 0): void {
    const photos = t.photosCount(count);
    const skipped = failed > 0 ? t.downloadSkipped(failed) : '';
    // 'shared' → went to the share sheet (iOS "Save to Photos"); 'cancelled' →
    // user dismissed, say nothing; otherwise it fell back to file downloads.
    if (outcome === 'shared') {
      setStatus(t.sentToShare(photos, skipped));
    } else if (outcome !== 'cancelled') {
      setStatus(t.downloadedPhotos(photos, skipped));
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
      savePhotosIndividually(files, { title: t.shareTitle })
        .then((outcome) => reportSave(outcome, files.length))
        .catch((e) => setError(e instanceof Error ? e.message : t.couldNotSavePhotos))
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
          setError(t.couldNotLoadAny);
          return;
        }
        reportSave(
          await savePhotosIndividually(files, { title: t.shareTitle }),
          files.length,
          failed,
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : t.couldNotSavePhotos);
      } finally {
        setSaving(false);
        setSaveProgress(null);
      }
    })();
  }

  return (
    <div>
      <div className="gallery-header">
        <h2>{t.title}</h2>
        <Link to={`/events/${eventId}`} className="btn btn-light">
          {t.backToGallery}
        </Link>
      </div>

      {phase === 'consent' && (
        <div className="consent-card">
          <h3>{t.beforeWeSearch}</h3>
          <p>{t.consentIntro}</p>
          <p className="muted">{t.consentIntroZh}</p>
          {error && <p className="error-text">{error}</p>}
          <label className="consent-row consent-name">
            <span>{t.yourNameRequired}</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t.namePlaceholder}
              maxLength={120}
              autoComplete="name"
              required
              aria-required="true"
            />
            <span className="field-hint muted">{t.nameHint}</span>
          </label>
          <label className="consent-row">
            <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
            <span>{t.consentPhoto}</span>
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
            <span>{t.isMinor}</span>
          </label>
          {isMinor && (
            <label className="consent-row consent-guardian">
              <input
                type="checkbox"
                checked={guardianOk}
                onChange={(e) => setGuardianOk(e.target.checked)}
              />
              <span>{t.guardianConsent}</span>
            </label>
          )}
          {!consentOk && consentHint && (
            <p className="field-hint muted" role="status">
              {consentHint}
            </p>
          )}
          <button className="btn btn-primary" disabled={!consentOk} onClick={() => { setError(null); setPhase('pick'); }}>
            {t.continue}
          </button>
        </div>
      )}

      {phase === 'pick' && (
        <div className="consent-card">
          <h3>{references.length > 0 ? t.addAnotherPhoto : t.uploadYourself}</h3>
          <p className="muted">{t.pickHint}</p>
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
            {t.chooseTakePhoto}
          </button>
          {noFaceFile && (
            <button className="btn btn-light" onClick={() => void search(noFaceFile, 'person')}>
              {t.searchByOutfitInstead}
            </button>
          )}
          {/* Standard (face) vs outfit search, so people understand the choice —
              especially after a "no clear face" fallback is offered. */}
          <div className="mode-note muted">
            <p>
              <strong>{t.standardSearch}</strong> {t.standardSearchDesc}
            </p>
            <p>
              <strong>{t.searchByOutfit}</strong> {t.searchByOutfitDesc}
            </p>
          </div>
          {references.length > 0 && (
            <button className="btn btn-light" onClick={() => setPhase('results')}>
              {t.cancel}
            </button>
          )}

          {pastUploads && pastUploads.length > 0 && (
            <div className="past-uploads">
              <h4>{t.reusePrevious}</h4>
              <p className="muted">{t.reuseHint}</p>
              <div className="past-grid">
                {pastUploads.map((u) => {
                  const checked = selectedPast.has(u.uploadId);
                  return (
                    <button
                      key={u.uploadId}
                      className={`past-cell${checked ? ' selected' : ''}`}
                      aria-pressed={checked}
                      onClick={() => togglePast(u.uploadId)}
                      title={u.mode === 'person' ? t.outfitMatch : t.faceMatch}
                    >
                      <img src={u.url} alt={t.previousUploadAlt} loading="lazy" />
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
                {t.matchWithSelected(selectedPast.size)}
              </button>
            </div>
          )}
        </div>
      )}

      {phase === 'searching' && (
        <div className="searching" role="status" aria-live="polite">
          <span className="spinner" aria-hidden="true" />
          <div>
            <p className="searching-title">{t.searchingTitle}</p>
            <p className="muted">{t.searchingHint}</p>
          </div>
        </div>
      )}

      {phase === 'results' && (
        <div>
          {references.length > 1 && (
            <div className="ref-picker" role="tablist" aria-label={t.referencePhotos}>
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
                <span>{t.combined}</span>
              </button>
            </div>
          )}

          {references.length === 1 && activeRef && (
            <div className="ref-current">
              {activeRef.previewUrl && (
                <img src={activeRef.previewUrl} alt={t.yourReferenceAlt} />
              )}
              <span className="muted">{t.resultsForPhoto}</span>
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
              {isCombined ? t.noMatchesCombined : t.noMatchesSingle}{' '}
              {t.tryThe}{' '}
              <Link to={`/events/${eventId}`}>{t.fullGallery}</Link> {t.orAddAnother}
            </p>
          ) : (
            <>
              <div className="results-toolbar">
                <p className="muted results-count">
                  {isCombined
                    ? t.matchesCombined(visible.length)
                    : t.matchesSingle(visible.length)}{' '}
                  {t.tapToEnlarge}
                </p>
                {visible.length > FINDME_PAGE_SIZE_OPTIONS[0] && (
                  <PageSizeSelect
                    value={pageSize}
                    onChange={setPageSize}
                    label={t.matchesPerPage}
                    options={FINDME_PAGE_SIZE_OPTIONS}
                  />
                )}
              </div>
              {pageCount > 1 && (
                <p className="muted batch-hint">
                  {t.showingRange(rangeStart, rangeEnd, visible.length)}
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
                selectAllLabel={t.selectPage}
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
                        aria-label={t.enlargePhoto}
                        onClick={() => setLightboxIndex(i)}
                      >
                        <img src={r.thumbUrl} alt="" loading="lazy" />
                        {/* C7: confidence band (the raw % stays as detail). */}
                        <span className={`score-chip band-${band}`}>
                          {band === 'strong' ? t.bandStrong : t.bandPossible} ·{' '}
                          {Math.round(r.score * 100)}%
                        </span>
                      </button>
                      <button
                        className="select-box"
                        aria-pressed={checked}
                        aria-label={checked ? t.deselectPhoto : t.selectPhoto}
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
                            {t.notMe}
                          </button>
                          <button
                            className={`btn-feedback${confirmed.has(r.photoId) ? ' confirmed' : ''}`}
                            onClick={() => handleConfirm(activeRef, r.photoId)}
                          >
                            {confirmed.has(r.photoId) ? t.meConfirmed : t.thatsMe}
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
            {t.addAnotherPhotoBtn}
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
                      {band === 'strong' ? t.bandStrong : t.bandPossible} ·{' '}
                      {Math.round(r.score * 100)}%
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
                      {checked ? t.selectedLightbox : t.select}
                    </button>
                    {!isCombined && activeRef && (
                      <>
                        <button
                          className="btn btn-light btn-sm"
                          onClick={() => handleNotMe(activeRef, item.key)}
                        >
                          {t.notMe}
                        </button>
                        <button
                          className={`btn btn-sm ${confirmed.has(item.key) ? 'btn-primary' : 'btn-light'}`}
                          onClick={() => handleConfirm(activeRef, item.key)}
                        >
                          {confirmed.has(item.key) ? t.meConfirmed : t.thatsMe}
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
