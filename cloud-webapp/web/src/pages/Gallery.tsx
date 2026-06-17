import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { ListPhotosResponse, GalleryPhoto, DownloadRequest } from '@cloud-webapp/shared';
import { apiGet, apiDownloadFile, apiGetBlob, ApiError } from '../lib/api.js';
import { useSelection } from '../lib/selection.js';
import { eventLabel } from '../lib/eventLabel.js';
import { savePhotosIndividually, type NamedBlob } from '../lib/downloads.js';
import { SelectBar } from '../components/SelectBar.js';

export function Gallery(): JSX.Element {
  const { eventId = '' } = useParams();
  const [photos, setPhotos] = useState<GalleryPhoto[] | null>(null);
  const [eventName, setEventName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<GalleryPhoto | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  function filenameFor(p: GalleryPhoto): string {
    const base = (p.name || '').split(/[/\\]/).pop()?.trim();
    return base || `${p.photoId}.jpg`;
  }

  const ids = (photos ?? []).map((p) => p.photoId);
  const sel = useSelection(ids);

  useEffect(() => {
    apiGet<ListPhotosResponse>(`/api/events/${encodeURIComponent(eventId)}/photos`)
      .then((r) => {
        setPhotos(r.photos);
        setEventName(r.eventName ?? '');
      })
      .catch((e: ApiError | Error) => setError(e.message));
  }, [eventId]);

  const title = eventLabel({ name: eventName, id: eventId, hasPhotos: (photos?.length ?? 0) > 0 });

  async function downloadSelected(): Promise<void> {
    if (sel.count === 0) return;
    setDownloading(true);
    setNotice(null);
    try {
      const body: DownloadRequest = { photoIds: [...sel.selected] };
      await apiDownloadFile(`/api/events/${encodeURIComponent(eventId)}/download`, body, `${title}.zip`);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Download failed');
    } finally {
      setDownloading(false);
    }
  }

  async function downloadIndividual(): Promise<void> {
    if (sel.count === 0) return;
    setDownloading(true);
    setNotice(null);
    try {
      const chosen = (photos ?? []).filter((p) => sel.isSelected(p.photoId));
      const files: NamedBlob[] = [];
      for (const p of chosen) {
        const blob = await apiGetBlob(
          `/api/events/${encodeURIComponent(eventId)}/photos/${encodeURIComponent(p.photoId)}/original`,
        );
        files.push({ blob, filename: filenameFor(p) });
      }
      await savePhotosIndividually(files, { title });
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Download failed');
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div>
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link to="/">← All events</Link>
      </nav>

      <div className="gallery-header">
        <h2>{title}</h2>
        <div className="gallery-actions">
          <button
            className={`btn btn-sm ${selectMode ? 'btn-primary' : 'btn-light'}`}
            onClick={() => {
              setSelectMode((m) => !m);
              sel.selectNone();
            }}
            disabled={(photos?.length ?? 0) === 0}
          >
            {selectMode ? 'Done selecting' : 'Select & download'}
          </button>
          <Link to={`/events/${eventId}/findme`} className="btn btn-primary btn-sm">
            📷 Find Me
          </Link>
        </div>
      </div>

      {error && <p className="error-text">Could not load photos: {error}</p>}
      {notice && <p className="error-text">{notice}</p>}
      {photos === null && !error && <p className="muted">Loading photos…</p>}
      {photos?.length === 0 && (
        <p className="muted">No photos indexed for this event yet — ask an admin to run indexing.</p>
      )}

      {selectMode && (photos?.length ?? 0) > 0 && (
        <SelectBar
          total={ids.length}
          selectedCount={sel.count}
          busy={downloading}
          onSelectAll={sel.selectAll}
          onSelectNone={sel.selectNone}
          onInvert={sel.invert}
          onDownload={() => void downloadSelected()}
          onDownloadIndividual={() => void downloadIndividual()}
        />
      )}

      <div className="photo-grid">
        {photos?.map((p) => {
          const checked = sel.isSelected(p.photoId);
          return (
            <button
              key={p.photoId}
              className={`photo-cell${selectMode && checked ? ' selected' : ''}`}
              aria-pressed={selectMode ? checked : undefined}
              onClick={() => (selectMode ? sel.toggle(p.photoId) : setLightbox(p))}
            >
              <img src={p.thumbUrl} alt={p.name} loading="lazy" />
              {selectMode && <span className="select-tick">{checked ? '✓' : ''}</span>}
            </button>
          );
        })}
      </div>

      {lightbox && (
        <div className="lightbox" onClick={() => setLightbox(null)}>
          <img src={lightbox.webUrl} alt={lightbox.name} />
          <a
            className="btn btn-light"
            href={lightbox.webUrl}
            download={lightbox.name || `${lightbox.photoId}.jpg`}
            onClick={(e) => e.stopPropagation()}
          >
            ⬇ Download
          </a>
        </div>
      )}
    </div>
  );
}
