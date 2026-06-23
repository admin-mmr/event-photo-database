import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type {
  ListPhotosResponse,
  GalleryPhoto,
  GetEventResponse,
  PhotoWebUrlResponse,
  DeletePhotosResponse,
} from '@cloud-webapp/shared';
import { apiGet, apiPost, apiGetBlob, ApiError } from '../lib/api.js';
import { useAuth } from '../lib/useAuth.js';
import { useSelection } from '../lib/selection.js';
import { eventLabel } from '../lib/eventLabel.js';
import { savePhotosIndividually, type NamedBlob } from '../lib/downloads.js';
import { downloadOriginalsZip } from '../lib/zipDownload.js';
import { reportClientError } from '../lib/reportError.js';
import { saveToPhone, canShareImageFiles, type ShareOutcome } from '../lib/share.js';
import { usePageSize } from '../lib/pageSize.js';
import { useSortMode } from '../lib/sortMode.js';
import { SelectBar } from '../components/SelectBar.js';
import { Lightbox } from '../components/Lightbox.js';
import { PageSizeSelect } from '../components/PageSizeSelect.js';
import { SortSelect } from '../components/SortSelect.js';
import { LoadMore } from '../components/LoadMore.js';

/** State of the admin delete stepper. `phase` is the overall stage; `reindex`
 *  tracks step 4 (the Find Me re-index) independently since it's polled. */
interface DeleteFlow {
  /** How many photos were actually deleted (drives the heading). */
  count: number;
  phase: 'removing' | 'reindexing' | 'done';
  /** How many requested photos could NOT be deleted (shown as a warning). */
  failed: number;
  reindex: 'active' | 'done' | 'skipped';
}

export function Gallery(): JSX.Element {
  const { eventId = '' } = useParams();
  const [photos, setPhotos] = useState<GalleryPhoto[] | null>(null);
  const [eventName, setEventName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Live progress for the admin delete (the 4-step stepper). Steps 1-3 (Trash /
  // copies / index) resolve together when the POST returns; step 4 (Find Me
  // re-index) is polled from the event's indexState until it lands. Null = no
  // delete in progress / nothing to show.
  const [deleteFlow, setDeleteFlow] = useState<DeleteFlow | null>(null);
  // Admin-only delete: guests (anonymous) never see the control; the API is the
  // real gate (requireAdmin → 403), matching the Index/Sync pattern on Events.
  const { user } = useAuth();
  const isAdmin = Boolean(user) && !user?.isAnonymous;
  // Transient success line after a save/download (announced via aria-live).
  const [status, setStatus] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Pagination: cursor for the next page (null = no more), plus a load guard.
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  // Full-size `web` URLs are signed lazily (the list ships thumbnails only), so
  // we cache them per photo as the lightbox requests them. A ref-set guards
  // against firing the same fetch twice for one photo.
  const [webUrls, setWebUrls] = useState<Record<string, string>>({});
  const webFetching = useRef<Set<string>>(new Set());

  // Original (full-resolution) blobs, cached per photo. Two jobs:
  //  1. iOS "Save to Photos" needs the image FILE in hand so `navigator.share`
  //     can be called *synchronously* inside the tap — fetching first burns the
  //     tap's transient activation and iOS then rejects the share. So we
  //     prefetch originals (current lightbox photo + selected photos) and only
  //     share once they're cached.
  //  2. On mobile the lightbox shows this original (full res) instead of the
  //     downsized `web` derivative.
  // A ref mirrors the state so the prefetch effect can skip already-cached
  // photos without taking `origBlobs` as a dependency (which would re-fire it).
  const [origBlobs, setOrigBlobs] = useState<Record<string, Blob>>({});
  const origBlobsRef = useRef<Record<string, Blob>>({});
  const origFetching = useRef<Set<string>>(new Set());
  // Selected ids whose original prefetch FAILED (e.g. a CORS/network error on
  // the signed-URL blob read). Counted as "settled" so the Save button stops
  // showing "Preparing…" instead of staying disabled forever; the tap then runs
  // saveSelected's fetch-then-share fallback, which retries and tolerates
  // per-photo failures.
  const [prefetchFailed, setPrefetchFailed] = useState<Set<string>>(new Set());
  // Watchdog: if a prefetch neither resolves nor rejects (hung request), stop
  // showing "Preparing…" after this long so the button stays usable.
  const [prepareTimedOut, setPrepareTimedOut] = useState(false);
  // Object URLs for displaying cached originals; created/revoked in lockstep
  // with `origBlobs` and fully revoked on unmount so we never leak blob URLs.
  const [origUrls, setOrigUrls] = useState<Record<string, string>>({});
  const origUrlsRef = useRef<Record<string, string>>({});
  // How many photos to fetch per page. Smaller = faster first paint; the user
  // can trade that for fewer "Load more" taps. Persisted + shared with Find Me.
  const { pageSize, setPageSize } = usePageSize();
  // Sort order (Newest first / Oldest first / By name). Persisted; changing it
  // re-fires the reset effect below (via loadPage's deps) to reload from page 1.
  const { sort, setSort } = useSortMode();

  // Mobile browsers (Web Share L2) can hand image files to the native share
  // sheet → iOS "Save N Images to Photos". On desktop this is false and ZIP
  // stays the primary action. Probe the real file-share capability (not just
  // `navigator.share`, which can exist without file support) so the button only
  // shows when it will actually work; a non-ZIP fallback is offered otherwise.
  const canSavePhotos = canShareImageFiles();

  function filenameFor(p: GalleryPhoto): string {
    const base = (p.name || '').split(/[/\\]/).pop()?.trim();
    return base || `${p.photoId}.jpg`;
  }

  const list = useMemo(() => photos ?? [], [photos]);
  const ids = useMemo(() => list.map((p) => p.photoId), [list]);
  const sel = useSelection(ids);

  // Photos whose originals we want cached: whatever the lightbox is showing
  // (for full-res display + one-tap save) plus everything currently selected
  // (for the batch "Save N to Photos"). `neededKey` is a stable string so the
  // prefetch/prune effects only re-run when the *set* changes, not every render.
  const neededIds = useMemo(() => {
    const s = new Set<string>(sel.selected);
    if (lightboxIndex !== null) {
      const p = list[lightboxIndex];
      if (p) s.add(p.photoId);
    }
    return s;
  }, [sel.selected, lightboxIndex, list]);
  const neededKey = useMemo(() => [...neededIds].sort().join(','), [neededIds]);

  // Every selected original has SETTLED — cached, or its prefetch failed. Once
  // settled we stop blocking the Save button so a failed prefetch can't pin it
  // on "Preparing…" forever; the tap then takes the fetch-then-share fallback.
  const selectedSettled =
    sel.count > 0 &&
    [...sel.selected].every((id) => Boolean(origBlobs[id]) || prefetchFailed.has(id));
  // True while we're still fetching selected originals (blocks the batch save).
  // Clears once everything settles or the watchdog fires, so the button can
  // never stay permanently disabled.
  const savePreparing =
    canSavePhotos && sel.count > 0 && !selectedSettled && !prepareTimedOut;

  // Load one page; append unless this is the first page (cursor === null).
  const loadPage = useCallback(
    async (cursor: string | null): Promise<void> => {
      const params = new URLSearchParams({ limit: String(pageSize), sort });
      if (cursor) params.set('cursor', cursor);
      const r = await apiGet<ListPhotosResponse>(
        `/api/events/${encodeURIComponent(eventId)}/photos?${params.toString()}`,
      );
      setEventName(r.eventName ?? '');
      setNextCursor(r.nextCursor ?? null);
      setPhotos((prev) => {
        if (cursor === null || prev === null) return r.photos;
        // Guard against any cross-page id overlap so keys stay unique.
        const seen = new Set(prev.map((p) => p.photoId));
        return [...prev, ...r.photos.filter((p) => !seen.has(p.photoId))];
      });
    },
    [eventId, pageSize, sort],
  );

  // First page on mount / event change. Reset paging state first.
  useEffect(() => {
    setPhotos(null);
    setNextCursor(null);
    setError(null);
    setDeleteFlow(null);
    setWebUrls({});
    webFetching.current = new Set();
    // Drop cached originals from the previous event and revoke their URLs.
    for (const url of Object.values(origUrlsRef.current)) URL.revokeObjectURL(url);
    origUrlsRef.current = {};
    origBlobsRef.current = {};
    origFetching.current = new Set();
    setOrigBlobs({});
    setOrigUrls({});
    loadPage(null).catch((e: ApiError | Error) => setError(e.message));
  }, [eventId, loadPage]);

  // Fetch the event name on its own (cheap, no photo signing) so the title
  // shows immediately instead of reading "Untitled event" until the slower
  // photo list resolves. Best-effort: the photos response also carries the
  // name, so a failure here just falls back to that.
  useEffect(() => {
    let cancelled = false;
    apiGet<GetEventResponse>(`/api/events/${encodeURIComponent(eventId)}`)
      .then((r) => {
        if (!cancelled && r.event.name) setEventName(r.event.name);
      })
      .catch(() => {
        /* non-fatal: title falls back to the photos response / eventLabel */
      });
    return () => {
      cancelled = true;
    };
  }, [eventId]);

  // Lazily load the full-size URL for whichever photo the lightbox is showing
  // (and we keep them once fetched). Until it arrives the lightbox shows the
  // thumbnail as a placeholder.
  useEffect(() => {
    if (lightboxIndex === null) return;
    const p = list[lightboxIndex];
    if (!p || webUrls[p.photoId] || webFetching.current.has(p.photoId)) return;
    webFetching.current.add(p.photoId);
    apiGet<PhotoWebUrlResponse>(
      `/api/events/${encodeURIComponent(eventId)}/photos/${encodeURIComponent(p.photoId)}/web`,
    )
      .then((r) => setWebUrls((prev) => ({ ...prev, [p.photoId]: r.webUrl })))
      .catch(() => webFetching.current.delete(p.photoId));
  }, [lightboxIndex, list, webUrls, eventId]);

  // Prefetch the originals we need (current lightbox photo + selected) so a save
  // can share synchronously and the lightbox can show full res. Mobile only —
  // desktop saves go through the on-demand download path and don't need this.
  // Reads the ref (not `origBlobs` state) to skip cached photos, so adding a
  // blob doesn't re-fire this effect; it re-runs only when `neededKey` changes.
  useEffect(() => {
    if (!canSavePhotos) return;
    for (const id of neededIds) {
      if (origBlobsRef.current[id] || origFetching.current.has(id)) continue;
      const p = list.find((x) => x.photoId === id);
      if (!p) continue;
      origFetching.current.add(id);
      fetchOriginal(p)
        .then((blob) => {
          origBlobsRef.current = { ...origBlobsRef.current, [id]: blob };
          setOrigBlobs(origBlobsRef.current);
          setPrefetchFailed((prev) => {
            if (!prev.has(id)) return prev;
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
        })
        .catch(() => {
          // Leave uncached and mark settled-as-failed so the Save button stops
          // waiting; the save falls back to fetch-then-share, display to `web`.
          setPrefetchFailed((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
        })
        .finally(() => origFetching.current.delete(id));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canSavePhotos, neededKey, list]);

  // Drop cached originals we no longer need (bounds mobile memory — realistic
  // selections are dozens; the 200-photo server cap is the hard bound). Revoke
  // their object URLs too. Keyed on `neededKey` so it runs when the set shrinks.
  useEffect(() => {
    let blobsChanged = false;
    for (const id of Object.keys(origBlobsRef.current)) {
      if (neededIds.has(id)) continue;
      const next = { ...origBlobsRef.current };
      delete next[id];
      origBlobsRef.current = next;
      blobsChanged = true;
    }
    if (blobsChanged) setOrigBlobs(origBlobsRef.current);
    // Forget failures for ids no longer needed so a future re-select retries.
    setPrefetchFailed((prev) => {
      const next = new Set([...prev].filter((id) => neededIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [neededKey]);

  // Prepare watchdog: if the prefetch hasn't settled within a few seconds (e.g.
  // a hung request), stop showing "Preparing…" so the Save button is tappable
  // and falls back to fetch-then-share. Reset on selection change or settle.
  useEffect(() => {
    setPrepareTimedOut(false);
    if (!canSavePhotos || sel.count === 0 || selectedSettled) return;
    const t = setTimeout(() => setPrepareTimedOut(true), 12_000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canSavePhotos, neededKey, selectedSettled]);

  // Keep one object URL per cached original for the lightbox <img>. Create for
  // new blobs, revoke for dropped ones. Guarded so React StrictMode's double
  // invoke can't leak (we only create when missing).
  useEffect(() => {
    const cur = origUrlsRef.current;
    let changed = false;
    for (const [id, blob] of Object.entries(origBlobs)) {
      if (!cur[id]) {
        cur[id] = URL.createObjectURL(blob);
        changed = true;
      }
    }
    for (const [id, url] of Object.entries(cur)) {
      if (!origBlobs[id]) {
        URL.revokeObjectURL(url);
        delete cur[id];
        changed = true;
      }
    }
    if (changed) setOrigUrls({ ...cur });
  }, [origBlobs]);

  // Revoke every outstanding object URL when the gallery unmounts.
  useEffect(
    () => () => {
      for (const url of Object.values(origUrlsRef.current)) URL.revokeObjectURL(url);
      origUrlsRef.current = {};
    },
    [],
  );

  const loadMore = useCallback((): void => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    loadPage(nextCursor)
      .catch((e: ApiError | Error) => setError(e.message))
      .finally(() => setLoadingMore(false));
  }, [nextCursor, loadingMore, loadPage]);

  // Infinite scroll: auto-load the next page when the sentinel scrolls into view.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !nextCursor) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMore();
      },
      { rootMargin: '600px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [nextCursor, loadMore]);

  // Step 4 of a delete: poll the event's indexState until the re-index finishes,
  // then flip "Refresh Find Me" to done. Runs only while a re-index is active;
  // gives up after 5 minutes (leaves the step showing "updating", which is true
  // — the job is just slow). Reuses GET /api/events/:id (same field the Events
  // page polls), so no new endpoint is needed.
  const reindexActive = deleteFlow?.reindex === 'active';
  useEffect(() => {
    if (!reindexActive) return;
    let cancelled = false;
    const startedAt = Date.now();
    const tick = (): void => {
      apiGet<GetEventResponse>(`/api/events/${encodeURIComponent(eventId)}`)
        .then((r) => {
          const status = r.event.indexState?.status;
          if (!cancelled && (status === 'done' || status === 'failed')) {
            setDeleteFlow((f) => (f ? { ...f, phase: 'done', reindex: 'done' } : f));
          }
        })
        .catch(() => {
          /* transient — keep polling */
        });
    };
    const id = setInterval(() => {
      if (Date.now() - startedAt > 5 * 60 * 1000) {
        clearInterval(id);
        return;
      }
      tick();
    }, 4000);
    tick();
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [reindexActive, eventId]);

  const title = eventLabel({ name: eventName, id: eventId, hasPhotos: list.length > 0 });

  async function fetchOriginal(p: GalleryPhoto): Promise<Blob> {
    return apiGetBlob(
      `/api/events/${encodeURIComponent(eventId)}/photos/${encodeURIComponent(p.photoId)}/original`,
    );
  }

  /** B1 ZIP download — the right call on desktop, the worst case on iOS (lands
   *  in Files, can't expand into Photos), so it's demoted on mobile. The ZIP is
   *  assembled in the browser from signed GCS URLs, so the originals bypass the
   *  Hosting `/api/**` rewrite (see lib/zipDownload). */
  async function downloadSelected(): Promise<void> {
    if (sel.count === 0) return;
    setDownloading(true);
    setNotice(null);
    setStatus(null);
    try {
      const { included, failed } = await downloadOriginalsZip(eventId, [...sel.selected], `${title}.zip`);
      const skipped =
        failed > 0 ? ` (${failed} couldn't be loaded and were skipped · ${failed} 张无法加载，已跳过)` : '';
      setStatus(
        `Downloaded ${included} photo${included === 1 ? '' : 's'} as a ZIP.${skipped} · 已将 ${included} 张照片打包为 ZIP 下载。`,
      );
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Download failed · 下载失败');
    } finally {
      setDownloading(false);
    }
  }

  /**
   * Admin "Delete" — remove the selected photos for good. Moves each Drive
   * original to Trash (recoverable ~30 days) and clears the index + derivatives,
   * then the API re-indexes so Find Me drops them too. Optimistically removes the
   * deleted ids from the on-screen list; a 403 means the signed-in user isn't an
   * admin (the control only shows for non-guests, but the server is the real gate).
   */
  async function deleteSelected(): Promise<void> {
    if (sel.count === 0) return;
    const n = sel.count;
    const ok = window.confirm(
      `Delete ${n} photo${n === 1 ? '' : 's'}?\n\n` +
        `This moves the original${n === 1 ? '' : 's'} to Google Drive Trash ` +
        `(recoverable for ~30 days) and removes ${n === 1 ? 'it' : 'them'} from ` +
        `the gallery and Find Me.\n\n` +
        `删除 ${n} 张照片？\n\n` +
        `原图将被移至 Google Drive 回收站（约 30 天内可恢复），` +
        `并从相册和「找到我」中移除。`,
    );
    if (!ok) return;

    const ids = [...sel.selected];
    setDeleting(true);
    setNotice(null);
    setStatus(null);
    // Steps 1-3 are in flight inside this one request; show them as active.
    setDeleteFlow({ count: ids.length, phase: 'removing', failed: 0, reindex: 'skipped' });
    try {
      const r = await apiPost<DeletePhotosResponse>(
        `/api/events/${encodeURIComponent(eventId)}/photos/delete`,
        { photoIds: ids },
      );
      const removed = new Set(r.deleted);
      setPhotos((prev) => (prev ?? []).filter((p) => !removed.has(p.photoId)));
      sel.selectNone();
      // Steps 1-3 done. Step 4 (re-index) is async: poll it if one was triggered.
      setDeleteFlow({
        count: r.deleted.length,
        phase: r.reindex ? 'reindexing' : 'done',
        failed: r.failed.length,
        reindex: r.reindex ? 'active' : 'skipped',
      });
    } catch (e) {
      setDeleteFlow(null);
      if (e instanceof ApiError && e.status === 403) {
        setNotice(
          'Deleting photos is admin-only — sign in with an admin account. · 删除照片仅限管理员，请使用管理员账号登录。',
        );
      } else {
        setNotice(e instanceof Error ? e.message : 'Could not delete photos. · 无法删除照片。');
      }
    } finally {
      setDeleting(false);
    }
  }

  /**
   * One-tap "Save to Photos" (the mobile headline action). Hands the actual
   * image FILES to the native share sheet — on iOS that yields "Save N Images to
   * Photos". A ZIP can't be expanded into the iOS photo library, so we
   * deliberately share images, not the ZIP.
   *
   * iOS only honours `navigator.share` while the tap's *transient activation* is
   * live, so we must NOT `await` a network fetch before calling it. On mobile
   * the selected originals are prefetched into `origBlobs` (the button stays
   * disabled — "Preparing…" — until they're all cached), so here we build the
   * files synchronously and share in the same tick. The fetch-then-share branch
   * below only runs on desktop, where the helper degrades to per-file downloads
   * and activation doesn't matter.
   */
  async function saveSelected(): Promise<void> {
    if (sel.count === 0) return;
    const n = sel.count;
    const label = `${n} photo${n === 1 ? '' : 's'}`;
    const labelZh = `${n} 张照片`;
    const chosen = list.filter((p) => sel.isSelected(p.photoId));

    setSaving(true);
    setNotice(null);
    setStatus(null);

    const cached = chosen
      .map((p) => ({ blob: origBlobs[p.photoId], filename: filenameFor(p) }))
      .filter((it): it is NamedBlob => Boolean(it.blob));

    // Fast path: all originals cached → share synchronously (no awaited fetch).
    if (canSavePhotos && cached.length === chosen.length) {
      savePhotosIndividually(cached, { title })
        .then((outcome) => {
          if (outcome === 'shared')
            setStatus(
              `Sent ${label} to your share sheet — choose Save to Photos. · 已将 ${labelZh} 发送到分享菜单，请选择「保存到照片」。`,
            );
          else if (outcome !== 'cancelled') setStatus(`Downloaded ${label}. · 已下载 ${labelZh}。`);
        })
        .catch((e) => setNotice(e instanceof Error ? e.message : 'Could not save photos · 无法保存照片'))
        .finally(() => setSaving(false));
      return;
    }

    // Fallback (desktop / a blob still loading / a failed prefetch): fetch then
    // save or download. Tolerate per-photo failures — one bad original must not
    // sink the whole save — and only error out if EVERY photo failed.
    try {
      const files: NamedBlob[] = [];
      let failed = 0;
      for (const p of chosen) {
        try {
          // eslint-disable-next-line no-await-in-loop
          files.push({ blob: await fetchOriginal(p), filename: filenameFor(p) });
        } catch {
          failed += 1;
        }
      }
      if (files.length === 0) {
        reportClientError('download_failed', 'Save to Photos: every original failed to load', {
          context: { eventId, requested: chosen.length, failed },
        });
        setNotice(
          'Could not load any of the selected photos. Please try again in a moment. · 无法加载所选的任何照片，请稍后重试。',
        );
        return;
      }
      const skipped = failed > 0 ? ` (${failed} skipped · 跳过 ${failed} 张)` : '';
      const outcome = await savePhotosIndividually(files, { title });
      if (outcome === 'shared')
        setStatus(
          `Sent ${label} to your share sheet — choose Save to Photos.${skipped} · 已将 ${labelZh} 发送到分享菜单，请选择「保存到照片」。`,
        );
      else if (outcome !== 'cancelled')
        setStatus(`Downloaded ${label}.${skipped} · 已下载 ${labelZh}。`);
    } catch (e) {
      reportClientError('download_failed', 'Save to Photos: original fetch failed', {
        stack: e instanceof Error ? e.stack : undefined,
        context: { eventId, requested: chosen.length, reason: e instanceof Error ? e.message : String(e) },
      });
      setNotice(e instanceof Error ? e.message : 'Could not save photos · 无法保存照片');
    } finally {
      setSaving(false);
    }
  }

  /** Per-file downloads (desktop fallback / "save individually"). */
  async function downloadIndividual(): Promise<void> {
    if (sel.count === 0) return;
    const n = sel.count;
    setDownloading(true);
    setNotice(null);
    setStatus(null);
    try {
      const chosen = list.filter((p) => sel.isSelected(p.photoId));
      const files: NamedBlob[] = [];
      for (const p of chosen) {
        // eslint-disable-next-line no-await-in-loop
        files.push({ blob: await fetchOriginal(p), filename: filenameFor(p) });
      }
      await savePhotosIndividually(files, { title });
      setStatus(`Saved ${n} photo${n === 1 ? '' : 's'}. · 已保存 ${n} 张照片。`);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Download failed · 下载失败');
    } finally {
      setDownloading(false);
    }
  }

  /**
   * Save a single photo (from the lightbox) straight to the phone's Photos.
   * On mobile the original is already cached (the lightbox prefetched it for
   * full-res display), so we share synchronously — no awaited fetch that would
   * burn the tap's user activation and make iOS reject the share. On desktop (or
   * if the blob hasn't landed yet) we fetch first and the helper downloads.
   */
  function saveOne(p: GalleryPhoto): void {
    setSaving(true);
    setNotice(null);
    setStatus(null);

    const report = (outcome: ShareOutcome): void => {
      if (outcome === 'shared')
        setStatus('Sent to your share sheet — choose Save to Photos. · 已发送到分享菜单，请选择「保存到照片」。');
      else if (outcome !== 'cancelled') setStatus('Saved 1 photo. · 已保存 1 张照片。');
    };

    const cached = origBlobs[p.photoId];
    if (canSavePhotos && cached) {
      saveToPhone(cached, filenameFor(p), { title })
        .then(report)
        .catch((e) => setNotice(e instanceof Error ? e.message : 'Could not save photo · 无法保存照片'))
        .finally(() => setSaving(false));
      return;
    }

    void (async () => {
      try {
        const blob = await fetchOriginal(p);
        report(await saveToPhone(blob, filenameFor(p), { title }));
      } catch (e) {
        setNotice(e instanceof Error ? e.message : 'Could not save photo · 无法保存照片');
      } finally {
        setSaving(false);
      }
    })();
  }

  /** Select a photo from the lightbox; flips on select mode so the bar appears. */
  function selectFromLightbox(photoId: string): void {
    if (!selectMode) setSelectMode(true);
    sel.toggle(photoId);
  }

  return (
    <div>
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link to="/">← All events · 全部活动</Link>
      </nav>

      <div className="gallery-header">
        <h2>{title}</h2>
        <div className="gallery-actions">
          <SortSelect value={sort} onChange={setSort} />
          <PageSizeSelect value={pageSize} onChange={setPageSize} />
          <button
            className={`btn btn-sm ${selectMode ? 'btn-primary' : 'btn-light'}`}
            onClick={() => {
              setSelectMode((m) => !m);
              sel.selectNone();
              setStatus(null);
            }}
            disabled={list.length === 0}
          >
            {selectMode ? 'Done · 完成' : 'Select photos · 选择照片'}
          </button>
          <Link to={`/events/${eventId}/findme`} className="btn btn-primary btn-sm">
            📷 Find Me · 找到我
          </Link>
        </div>
      </div>

      {error && <p className="error-text">Could not load photos · 无法加载照片：{error}</p>}
      {notice && <p className="error-text">{notice}</p>}
      {status && (
        <p className="status-text" role="status" aria-live="polite">
          {status}
        </p>
      )}

      {deleteFlow && (
        <div className="delete-progress" role="status" aria-live="polite">
          <div className="delete-progress-head">
            <strong>
              {deleteFlow.phase === 'done'
                ? `Deleted ${deleteFlow.count} photo${deleteFlow.count === 1 ? '' : 's'} · 已删除 ${deleteFlow.count} 张照片`
                : `Deleting ${deleteFlow.count} photo${deleteFlow.count === 1 ? '' : 's'}… · 正在删除 ${deleteFlow.count} 张照片…`}
            </strong>
            {deleteFlow.phase === 'done' && (
              <button className="btn btn-light btn-sm" onClick={() => setDeleteFlow(null)}>
                Dismiss · 关闭
              </button>
            )}
          </div>

          {(() => {
            const removalDone = deleteFlow.phase !== 'removing';
            const removal = removalDone ? 'done' : 'active';
            const rows: Array<{ label: string; sub: string; state: 'done' | 'active' }> = [
              {
                label: 'Move originals to Drive Trash · 将原图移至 Drive 回收站',
                sub: 'Recoverable for ~30 days · 约 30 天内可恢复',
                state: removal,
              },
              {
                label: 'Delete stored copies · 删除已存副本',
                sub: 'Thumbnail, web & original · 缩略图、网页版与原图',
                state: removal,
              },
              {
                label: 'Remove from gallery · 从相册移除',
                sub: 'Index entry cleared · 索引记录已清除',
                state: removal,
              },
            ];
            const reindexRow =
              deleteFlow.reindex === 'skipped'
                ? null
                : {
                    label: 'Refresh Find Me · 刷新「找到我」',
                    sub:
                      deleteFlow.reindex === 'done'
                        ? 'Find Me updated · 「找到我」已更新'
                        : 'Re-indexing… this can take a few minutes · 正在重新建立索引…可能需要几分钟',
                    state: deleteFlow.reindex,
                  };
            const all = reindexRow ? [...rows, reindexRow] : rows;
            return all.map((r) => (
              <div className="delete-step" key={r.label}>
                <span className={`del-badge del-${r.state}`} aria-hidden="true">
                  {r.state === 'done' ? '✓' : <span className="del-spin" />}
                </span>
                <span>
                  <span className="del-label">{r.label}</span>
                  <span className="del-sub">{r.sub}</span>
                </span>
              </div>
            ));
          })()}

          {deleteFlow.failed > 0 && (
            <p className="error-text delete-failed-note">
              {deleteFlow.failed} photo{deleteFlow.failed === 1 ? '' : 's'} could not be deleted. ·{' '}
              {deleteFlow.failed} 张照片无法删除。
            </p>
          )}
        </div>
      )}
      {photos === null && !error && <p className="muted">Loading photos… · 正在加载照片…</p>}
      {photos?.length === 0 && (
        <p className="muted">
          No photos indexed for this event yet — ask an admin to run indexing. · 本次活动尚未建立照片索引，请联系管理员运行索引。
        </p>
      )}

      {selectMode && list.length > 0 && (
        <>
          <p className="muted">
            {canSavePhotos
              ? 'Tap photos to select them, then “Save to Photos” to add them straight to your camera roll. · 点按照片进行选择，然后点「保存到相册」即可直接存入相册。'
              : 'Tap photos to select them, then save or download the originals. · 点按照片进行选择，然后保存或下载原图。'}
          </p>
          <SelectBar
            total={ids.length}
            selectedCount={sel.count}
            busy={downloading || saving || deleting}
            canSave={canSavePhotos}
            savePreparing={savePreparing}
            onSelectAll={sel.selectAll}
            onSelectNone={sel.selectNone}
            onInvert={sel.invert}
            onDownload={() => void downloadSelected()}
            onSaveToPhone={() => void saveSelected()}
            {...(canSavePhotos ? {} : { onDownloadIndividual: () => void downloadIndividual() })}
          />
          {isAdmin && (
            <div className="admin-delete-row">
              <button
                className="btn btn-sm btn-danger"
                disabled={sel.count === 0 || downloading || saving || deleting}
                onClick={() => void deleteSelected()}
              >
                {deleting
                  ? 'Deleting… · 删除中…'
                  : `🗑 Delete${sel.count ? ` ${sel.count}` : ''} · 删除${sel.count ? ` ${sel.count}` : ''}`}
              </button>
              <span className="muted">
                Admin only — moves originals to Drive Trash. · 仅限管理员——会将原图移至 Drive 回收站。
              </span>
            </div>
          )}
        </>
      )}

      <div className="photo-grid">
        {list.map((p, i) => {
          const checked = sel.isSelected(p.photoId);
          return (
            <button
              key={p.photoId}
              className={`photo-cell${selectMode && checked ? ' selected' : ''}`}
              aria-pressed={selectMode ? checked : undefined}
              onClick={() => (selectMode ? sel.toggle(p.photoId) : setLightboxIndex(i))}
            >
              <img src={p.thumbUrl} alt={p.name} loading="lazy" />
              {selectMode && <span className="select-tick">{checked ? '✓' : ''}</span>}
            </button>
          );
        })}
      </div>

      <LoadMore
        ref={sentinelRef}
        shownCount={list.length}
        hasMore={nextCursor !== null}
        loading={loadingMore}
        onLoadMore={loadMore}
        noun="photo"
      />

      {lightboxIndex !== null && list[lightboxIndex] && (
        <Lightbox
          items={list.map((p) => ({
            key: p.photoId,
            // Mobile shows the full-resolution original (cached as an object
            // URL); until it lands, and on desktop, fall back to the `web`
            // derivative, then the thumbnail.
            src:
              (canSavePhotos ? origUrls[p.photoId] : undefined) ??
              webUrls[p.photoId] ??
              p.thumbUrl,
            // If the original can't decode (e.g. HEIC off-Safari), drop to JPEG.
            fallbackSrc: webUrls[p.photoId] ?? p.thumbUrl,
            alt: p.name,
          }))}
          index={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
          onNavigate={setLightboxIndex}
          renderFooter={(item, idx) => {
            const p = list[idx];
            if (!p) return null;
            const checked = sel.isSelected(item.key);
            // On mobile the original must be cached before we can share it
            // synchronously, so disable until it lands ("Preparing…").
            const preparing = canSavePhotos && !origBlobs[item.key];
            return (
              <>
                <button
                  className="btn btn-primary btn-sm"
                  disabled={saving || preparing}
                  onClick={() => saveOne(p)}
                >
                  {!canSavePhotos
                    ? '⬇ Download · 下载'
                    : preparing
                      ? 'Preparing… · 准备中…'
                      : '📲 Save to Photos · 保存到照片'}
                </button>
                <button
                  className={`btn btn-sm ${checked ? 'btn-primary' : 'btn-light'}`}
                  onClick={() => selectFromLightbox(item.key)}
                >
                  {checked ? '✓ Selected · 已选中' : 'Select · 选择'}
                </button>
              </>
            );
          }}
        />
      )}
    </div>
  );
}
