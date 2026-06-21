import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type {
  ListPhotosResponse,
  GalleryPhoto,
  DownloadRequest,
  GetEventResponse,
  PhotoWebUrlResponse,
} from '@cloud-webapp/shared';
import { apiGet, apiDownloadFile, apiGetBlob, ApiError } from '../lib/api.js';
import { useSelection } from '../lib/selection.js';
import { eventLabel } from '../lib/eventLabel.js';
import { savePhotosIndividually, type NamedBlob } from '../lib/downloads.js';
import { reportClientError } from '../lib/reportError.js';
import { saveToPhone, type ShareOutcome } from '../lib/share.js';
import { usePageSize } from '../lib/pageSize.js';
import { useSortMode } from '../lib/sortMode.js';
import { SelectBar } from '../components/SelectBar.js';
import { Lightbox } from '../components/Lightbox.js';
import { PageSizeSelect } from '../components/PageSizeSelect.js';
import { SortSelect } from '../components/SortSelect.js';
import { LoadMore } from '../components/LoadMore.js';

export function Gallery(): JSX.Element {
  const { eventId = '' } = useParams();
  const [photos, setPhotos] = useState<GalleryPhoto[] | null>(null);
  const [eventName, setEventName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [saving, setSaving] = useState(false);
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
  // stays the primary action.
  const canSavePhotos = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

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

  // All selected originals are cached → the batch share can fire synchronously.
  const selectedReady =
    sel.count > 0 && [...sel.selected].every((id) => Boolean(origBlobs[id]));
  // True while we're still fetching selected originals (blocks the batch save).
  const savePreparing = canSavePhotos && sel.count > 0 && !selectedReady;

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
        })
        .catch(() => {
          /* leave uncached; save falls back to a download, display to `web` */
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [neededKey]);

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

  const title = eventLabel({ name: eventName, id: eventId, hasPhotos: list.length > 0 });

  async function fetchOriginal(p: GalleryPhoto): Promise<Blob> {
    return apiGetBlob(
      `/api/events/${encodeURIComponent(eventId)}/photos/${encodeURIComponent(p.photoId)}/original`,
    );
  }

  /** B1 ZIP download — the right call on desktop, the worst case on iOS (lands
   *  in Files, can't expand into Photos), so it's demoted on mobile. */
  async function downloadSelected(): Promise<void> {
    if (sel.count === 0) return;
    const n = sel.count;
    setDownloading(true);
    setNotice(null);
    setStatus(null);
    try {
      const body: DownloadRequest = { photoIds: [...sel.selected] };
      await apiDownloadFile(`/api/events/${encodeURIComponent(eventId)}/download`, body, `${title}.zip`);
      setStatus(`Downloaded ${n} photo${n === 1 ? '' : 's'} as a ZIP.`);
    } catch (e) {
      reportClientError('download_failed', 'ZIP download failed', {
        stack: e instanceof Error ? e.stack : undefined,
        context: { eventId, requested: n, reason: e instanceof Error ? e.message : String(e) },
      });
      setNotice(e instanceof Error ? e.message : 'Download failed');
    } finally {
      setDownloading(false);
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
          if (outcome === 'shared') setStatus(`Sent ${label} to your share sheet — choose Save to Photos.`);
          else if (outcome !== 'cancelled') setStatus(`Downloaded ${label}.`);
        })
        .catch((e) => setNotice(e instanceof Error ? e.message : 'Could not save photos'))
        .finally(() => setSaving(false));
      return;
    }

    // Fallback (desktop / a blob still loading): fetch then save or download.
    try {
      const files: NamedBlob[] = [];
      for (const p of chosen) {
        // eslint-disable-next-line no-await-in-loop
        files.push({ blob: await fetchOriginal(p), filename: filenameFor(p) });
      }
      const outcome = await savePhotosIndividually(files, { title });
      if (outcome === 'shared') setStatus(`Sent ${label} to your share sheet — choose Save to Photos.`);
      else if (outcome !== 'cancelled') setStatus(`Downloaded ${label}.`);
    } catch (e) {
      reportClientError('download_failed', 'Save to Photos: original fetch failed', {
        stack: e instanceof Error ? e.stack : undefined,
        context: { eventId, requested: chosen.length, reason: e instanceof Error ? e.message : String(e) },
      });
      setNotice(e instanceof Error ? e.message : 'Could not save photos');
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
      setStatus(`Saved ${n} photo${n === 1 ? '' : 's'}.`);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Download failed');
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
      if (outcome === 'shared') setStatus('Sent to your share sheet — choose Save to Photos.');
      else if (outcome !== 'cancelled') setStatus('Saved 1 photo.');
    };

    const cached = origBlobs[p.photoId];
    if (canSavePhotos && cached) {
      saveToPhone(cached, filenameFor(p), { title })
        .then(report)
        .catch((e) => setNotice(e instanceof Error ? e.message : 'Could not save photo'))
        .finally(() => setSaving(false));
      return;
    }

    void (async () => {
      try {
        const blob = await fetchOriginal(p);
        report(await saveToPhone(blob, filenameFor(p), { title }));
      } catch (e) {
        setNotice(e instanceof Error ? e.message : 'Could not save photo');
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
        <Link to="/">← All events</Link>
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
            {selectMode ? 'Done' : 'Select photos'}
          </button>
          <Link to={`/events/${eventId}/findme`} className="btn btn-primary btn-sm">
            📷 Find Me
          </Link>
        </div>
      </div>

      {error && <p className="error-text">Could not load photos: {error}</p>}
      {notice && <p className="error-text">{notice}</p>}
      {status && (
        <p className="status-text" role="status" aria-live="polite">
          {status}
        </p>
      )}
      {photos === null && !error && <p className="muted">Loading photos…</p>}
      {photos?.length === 0 && (
        <p className="muted">No photos indexed for this event yet — ask an admin to run indexing.</p>
      )}

      {selectMode && list.length > 0 && (
        <>
          <p className="muted">
            {canSavePhotos
              ? 'Tap photos to select them, then “Save to Photos” to add them straight to your camera roll.'
              : 'Tap photos to select them, then download the originals.'}
          </p>
          <SelectBar
            total={ids.length}
            selectedCount={sel.count}
            busy={downloading || saving}
            canSave={canSavePhotos}
            savePreparing={savePreparing}
            onSelectAll={sel.selectAll}
            onSelectNone={sel.selectNone}
            onInvert={sel.invert}
            onDownload={() => void downloadSelected()}
            onSaveToPhone={() => void saveSelected()}
            {...(canSavePhotos ? {} : { onDownloadIndividual: () => void downloadIndividual() })}
          />
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
                    ? '⬇ Download'
                    : preparing
                      ? 'Preparing…'
                      : '📲 Save to Photos'}
                </button>
                <button
                  className={`btn btn-sm ${checked ? 'btn-primary' : 'btn-light'}`}
                  onClick={() => selectFromLightbox(item.key)}
                >
                  {checked ? '✓ Selected' : 'Select'}
                </button>
              </>
            );
          }}
        />
      )}
    </div>
  );
}
