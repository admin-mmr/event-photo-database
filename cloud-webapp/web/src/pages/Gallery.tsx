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
import { useStrings } from '../lib/i18n.js';

const STR = {
  en: {
    downloadZip: (included: number, skipped: string) =>
      `Downloaded ${included} photo${included === 1 ? '' : 's'} as a ZIP.${skipped}`,
    downloadZipSkipped: (failed: number) =>
      ` (${failed} couldn't be loaded and were skipped)`,
    downloadFailed: 'Download failed',
    confirmDelete: (n: number) =>
      `Delete ${n} photo${n === 1 ? '' : 's'}?\n\n` +
      `This moves the original${n === 1 ? '' : 's'} to Google Drive Trash ` +
      `(recoverable for ~30 days) and removes ${n === 1 ? 'it' : 'them'} from ` +
      `the gallery and Find Me.`,
    deleteAdminOnly:
      'Deleting photos is admin-only — sign in with an admin account.',
    deleteFailed: 'Could not delete photos.',
    sentToShare: (label: string, skipped: string) =>
      `Sent ${label} to your share sheet — choose Save to Photos.${skipped}`,
    downloadedLabel: (label: string, skipped: string) => `Downloaded ${label}.${skipped}`,
    couldNotSavePhotos: 'Could not save photos',
    photoLabel: (n: number) => `${n} photo${n === 1 ? '' : 's'}`,
    saveSkipped: (failed: number) => ` (${failed} skipped)`,
    couldNotLoadAny:
      'Could not load any of the selected photos. Please try again in a moment.',
    savedPhotos: (n: number) => `Saved ${n} photo${n === 1 ? '' : 's'}.`,
    sentToShareOne: 'Sent to your share sheet — choose Save to Photos.',
    savedOnePhoto: 'Saved 1 photo.',
    couldNotSavePhoto: 'Could not save photo',
    breadcrumbAria: 'Breadcrumb',
    allEvents: '← All events',
    done: 'Done',
    selectPhotos: 'Select photos',
    findMe: '📷 Find Me',
    openAlbum: '📁 Open album in Drive',
    openAlbumClub: (club: string) => `📁 ${club} album`,
    allAlbums: '📑 All event folders',
    couldNotLoadPhotos: 'Could not load photos',
    deletedPhotos: (count: number) =>
      `Deleted ${count} photo${count === 1 ? '' : 's'}`,
    deletingPhotos: (count: number) =>
      `Deleting ${count} photo${count === 1 ? '' : 's'}…`,
    dismiss: 'Dismiss',
    moveOriginalsLabel: 'Move originals to Drive Trash',
    moveOriginalsSub: 'Recoverable for ~30 days',
    deleteCopiesLabel: 'Delete stored copies',
    deleteCopiesSub: 'Thumbnail, web & original',
    removeFromGalleryLabel: 'Remove from gallery',
    removeFromGallerySub: 'Index entry cleared',
    refreshFindMeLabel: 'Refresh Find Me',
    findMeUpdated: 'Find Me updated',
    reindexing: 'Re-indexing… this can take a few minutes',
    deleteFailedNote: (failed: number) =>
      `${failed} photo${failed === 1 ? '' : 's'} could not be deleted.`,
    loadingPhotos: 'Loading photos…',
    noPhotos:
      'No photos indexed for this event yet — ask an admin to run indexing.',
    selectHintSave:
      'Tap photos to select them, then “Save to Photos” to add them straight to your camera roll.',
    selectHintDownload:
      'Tap photos to select them, then save or download the originals.',
    deleting: 'Deleting…',
    deleteButton: (count: number) => `🗑 Delete${count ? ` ${count}` : ''}`,
    adminOnlyDelete: 'Admin only — moves originals to Drive Trash.',
    download: '⬇ Download',
    preparing: 'Preparing…',
    saveToPhotos: '📲 Save to Photos',
    selected: '✓ Selected',
    select: 'Select',
  },
  zh: {
    downloadZip: (included: number, skipped: string) =>
      `已将 ${included} 张照片打包为 ZIP 下载。${skipped}`,
    downloadZipSkipped: (failed: number) => ` (${failed} 张无法加载，已跳过)`,
    downloadFailed: '下载失败',
    confirmDelete: (n: number) =>
      `删除 ${n} 张照片？\n\n` +
      `原图将被移至 Google Drive 回收站（约 30 天内可恢复），` +
      `并从相册和人脸识别中移除。`,
    deleteAdminOnly: '删除照片仅限管理员，请使用管理员账号登录。',
    deleteFailed: '无法删除照片。',
    sentToShare: (label: string, skipped: string) =>
      `已将 ${label} 发送到分享菜单，请选择「保存到照片」。${skipped}`,
    downloadedLabel: (label: string, skipped: string) => `已下载 ${label}。${skipped}`,
    couldNotSavePhotos: '无法保存照片',
    photoLabel: (n: number) => `${n} 张照片`,
    saveSkipped: (failed: number) => ` (跳过 ${failed} 张)`,
    couldNotLoadAny: '无法加载所选的任何照片，请稍后重试。',
    savedPhotos: (n: number) => `已保存 ${n} 张照片。`,
    sentToShareOne: '已发送到分享菜单，请选择「保存到照片」。',
    savedOnePhoto: '已保存 1 张照片。',
    couldNotSavePhoto: '无法保存照片',
    breadcrumbAria: '面包屑导航',
    allEvents: '← 全部活动',
    done: '完成',
    selectPhotos: '选择照片',
    findMe: '📷 人脸识别',
    openAlbum: '📁 在 Drive 中打开相册',
    openAlbumClub: (club: string) => `📁 ${club} 相册`,
    allAlbums: '📑 所有活动文件夹',
    couldNotLoadPhotos: '无法加载照片',
    deletedPhotos: (count: number) => `已删除 ${count} 张照片`,
    deletingPhotos: (count: number) => `正在删除 ${count} 张照片…`,
    dismiss: '关闭',
    moveOriginalsLabel: '将原图移至 Drive 回收站',
    moveOriginalsSub: '约 30 天内可恢复',
    deleteCopiesLabel: '删除已存副本',
    deleteCopiesSub: '缩略图、网页版与原图',
    removeFromGalleryLabel: '从相册移除',
    removeFromGallerySub: '索引记录已清除',
    refreshFindMeLabel: '刷新人脸识别',
    findMeUpdated: '人脸识别已更新',
    reindexing: '正在重新建立索引…可能需要几分钟',
    deleteFailedNote: (failed: number) => `${failed} 张照片无法删除。`,
    loadingPhotos: '正在加载照片…',
    noPhotos: '本次活动尚未建立照片索引，请联系管理员运行索引。',
    selectHintSave:
      '点按照片进行选择，然后点「保存到相册」即可直接存入相册。',
    selectHintDownload: '点按照片进行选择，然后保存或下载原图。',
    deleting: '删除中…',
    deleteButton: (count: number) => `删除${count ? ` ${count}` : ''}`,
    adminOnlyDelete: '仅限管理员——会将原图移至 Drive 回收站。',
    download: '⬇ 下载',
    preparing: '准备中…',
    saveToPhotos: '📲 保存到照片',
    selected: '✓ 已选中',
    select: '选择',
  },
};

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

/** A managed Album folder link for the event (one per club/tag scope). */
interface AlbumFolder {
  clubName: string;
  tag: string;
  folderUrl: string;
  fileCount: number;
}

export function Gallery(): JSX.Element {
  const t = useStrings(STR);
  const { eventId = '' } = useParams();
  const [photos, setPhotos] = useState<GalleryPhoto[] | null>(null);
  const [eventName, setEventName] = useState('');
  const [albumFolders, setAlbumFolders] = useState<AlbumFolder[]>([]);
  const [albumsIndexUrl, setAlbumsIndexUrl] = useState<string | null>(null);
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

  // The managed Album folder link(s) so visitors can browse the raw files in
  // Drive. Best-effort; reduced to one link per club (preferring the club-level
  // album that holds everything) in `albumLinks`.
  useEffect(() => {
    let cancelled = false;
    apiGet<{ ok: true; folders: AlbumFolder[] }>(`/api/events/${encodeURIComponent(eventId)}/album-folders`)
      .then((r) => {
        if (!cancelled) setAlbumFolders(r.folders ?? []);
      })
      .catch(() => {
        if (!cancelled) setAlbumFolders([]);
      });
    return () => {
      cancelled = true;
    };
  }, [eventId]);

  // The world-readable Managed Albums index sheet (all events' Photo/Video/Album
  // folders, each a raw Drive link). Best-effort; the link is hidden when the
  // public index is unconfigured. Event-independent, so fetched once.
  useEffect(() => {
    let cancelled = false;
    apiGet<{ ok: true; url: string | null }>('/api/managed-albums')
      .then((r) => {
        if (!cancelled) setAlbumsIndexUrl(r.url ?? null);
      })
      .catch(() => {
        if (!cancelled) setAlbumsIndexUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

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

  // One album link per club: prefer the club-level album (tag === '') which
  // contains everything; fall back to the first tag-scoped album otherwise. This
  // avoids showing several overlapping "Album" links for the same club.
  const albumLinks = useMemo<AlbumFolder[]>(() => {
    const byClub = new Map<string, AlbumFolder>();
    for (const f of albumFolders) {
      const existing = byClub.get(f.clubName);
      if (!existing || (f.tag === '' && existing.tag !== '')) byClub.set(f.clubName, f);
    }
    return [...byClub.values()];
  }, [albumFolders]);

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
      const skipped = failed > 0 ? t.downloadZipSkipped(failed) : '';
      setStatus(t.downloadZip(included, skipped));
    } catch (e) {
      setNotice(e instanceof Error ? e.message : t.downloadFailed);
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
    const ok = window.confirm(t.confirmDelete(n));
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
        setNotice(t.deleteAdminOnly);
      } else {
        setNotice(e instanceof Error ? e.message : t.deleteFailed);
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
    const label = t.photoLabel(n);
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
          if (outcome === 'shared') setStatus(t.sentToShare(label, ''));
          else if (outcome !== 'cancelled') setStatus(t.downloadedLabel(label, ''));
        })
        .catch((e) => setNotice(e instanceof Error ? e.message : t.couldNotSavePhotos))
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
        setNotice(t.couldNotLoadAny);
        return;
      }
      const skipped = failed > 0 ? t.saveSkipped(failed) : '';
      const outcome = await savePhotosIndividually(files, { title });
      if (outcome === 'shared') setStatus(t.sentToShare(label, skipped));
      else if (outcome !== 'cancelled') setStatus(t.downloadedLabel(label, skipped));
    } catch (e) {
      reportClientError('download_failed', 'Save to Photos: original fetch failed', {
        stack: e instanceof Error ? e.stack : undefined,
        context: { eventId, requested: chosen.length, reason: e instanceof Error ? e.message : String(e) },
      });
      setNotice(e instanceof Error ? e.message : t.couldNotSavePhotos);
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
      setStatus(t.savedPhotos(n));
    } catch (e) {
      setNotice(e instanceof Error ? e.message : t.downloadFailed);
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
      if (outcome === 'shared') setStatus(t.sentToShareOne);
      else if (outcome !== 'cancelled') setStatus(t.savedOnePhoto);
    };

    const cached = origBlobs[p.photoId];
    if (canSavePhotos && cached) {
      saveToPhone(cached, filenameFor(p), { title })
        .then(report)
        .catch((e) => setNotice(e instanceof Error ? e.message : t.couldNotSavePhoto))
        .finally(() => setSaving(false));
      return;
    }

    void (async () => {
      try {
        const blob = await fetchOriginal(p);
        report(await saveToPhone(blob, filenameFor(p), { title }));
      } catch (e) {
        setNotice(e instanceof Error ? e.message : t.couldNotSavePhoto);
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
      <nav className="breadcrumb" aria-label={t.breadcrumbAria}>
        <Link to="/">{t.allEvents}</Link>
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
            {selectMode ? t.done : t.selectPhotos}
          </button>
          {albumLinks.map((f) => (
            <a
              key={f.folderUrl}
              className="btn btn-light btn-sm"
              href={f.folderUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              {albumLinks.length === 1 ? t.openAlbum : t.openAlbumClub(f.clubName || f.tag || '—')}
            </a>
          ))}
          {albumsIndexUrl && (
            <a className="btn btn-light btn-sm" href={albumsIndexUrl} target="_blank" rel="noopener noreferrer">
              {t.allAlbums}
            </a>
          )}
          <Link to={`/events/${eventId}/findme`} className="btn btn-primary btn-sm">
            {t.findMe}
          </Link>
        </div>
      </div>

      {error && <p className="error-text">{t.couldNotLoadPhotos}：{error}</p>}
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
                ? t.deletedPhotos(deleteFlow.count)
                : t.deletingPhotos(deleteFlow.count)}
            </strong>
            {deleteFlow.phase === 'done' && (
              <button className="btn btn-light btn-sm" onClick={() => setDeleteFlow(null)}>
                {t.dismiss}
              </button>
            )}
          </div>

          {(() => {
            const removalDone = deleteFlow.phase !== 'removing';
            const removal = removalDone ? 'done' : 'active';
            const rows: Array<{ label: string; sub: string; state: 'done' | 'active' }> = [
              {
                label: t.moveOriginalsLabel,
                sub: t.moveOriginalsSub,
                state: removal,
              },
              {
                label: t.deleteCopiesLabel,
                sub: t.deleteCopiesSub,
                state: removal,
              },
              {
                label: t.removeFromGalleryLabel,
                sub: t.removeFromGallerySub,
                state: removal,
              },
            ];
            const reindexRow =
              deleteFlow.reindex === 'skipped'
                ? null
                : {
                    label: t.refreshFindMeLabel,
                    sub:
                      deleteFlow.reindex === 'done'
                        ? t.findMeUpdated
                        : t.reindexing,
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
            <p className="error-text delete-failed-note">{t.deleteFailedNote(deleteFlow.failed)}</p>
          )}
        </div>
      )}
      {photos === null && !error && <p className="muted">{t.loadingPhotos}</p>}
      {photos?.length === 0 && <p className="muted">{t.noPhotos}</p>}

      {selectMode && list.length > 0 && (
        <>
          <p className="muted">
            {canSavePhotos ? t.selectHintSave : t.selectHintDownload}
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
                {deleting ? t.deleting : t.deleteButton(sel.count)}
              </button>
              <span className="muted">{t.adminOnlyDelete}</span>
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
                    ? t.download
                    : preparing
                      ? t.preparing
                      : t.saveToPhotos}
                </button>
                <button
                  className={`btn btn-sm ${checked ? 'btn-primary' : 'btn-light'}`}
                  onClick={() => selectFromLightbox(item.key)}
                >
                  {checked ? t.selected : t.select}
                </button>
              </>
            );
          }}
        />
      )}
    </div>
  );
}
