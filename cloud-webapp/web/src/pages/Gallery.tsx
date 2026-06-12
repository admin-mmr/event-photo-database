import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { ListPhotosResponse, GalleryPhoto } from '@cloud-webapp/shared';
import { apiGet, ApiError } from '../lib/api.js';

export function Gallery(): JSX.Element {
  const { eventId = '' } = useParams();
  const [photos, setPhotos] = useState<GalleryPhoto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<GalleryPhoto | null>(null);

  useEffect(() => {
    apiGet<ListPhotosResponse>(`/api/events/${encodeURIComponent(eventId)}/photos`)
      .then((r) => setPhotos(r.photos))
      .catch((e: ApiError | Error) => setError(e.message));
  }, [eventId]);

  return (
    <div>
      <div className="gallery-header">
        <h2>Gallery</h2>
        <Link to={`/events/${eventId}/findme`} className="btn btn-primary">
          📷 Find Me
        </Link>
      </div>

      {error && <p className="error-text">Could not load photos: {error}</p>}
      {photos === null && !error && <p className="muted">Loading photos…</p>}
      {photos?.length === 0 && (
        <p className="muted">No photos indexed for this event yet — ask an admin to run indexing.</p>
      )}

      <div className="photo-grid">
        {photos?.map((p) => (
          <button key={p.photoId} className="photo-cell" onClick={() => setLightbox(p)}>
            <img src={p.thumbUrl} alt={p.name} loading="lazy" />
          </button>
        ))}
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
