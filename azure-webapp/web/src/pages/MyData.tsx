import { useCallback, useEffect, useState } from 'react';
import type {
  ListReferencesResponse,
  ReferenceUpload,
  DeleteReferenceResponse,
  DeleteMyDataResponse,
} from '@cloud-webapp/shared';
import { apiGet, apiDelete, ApiError } from '../lib/api.js';

function fmtDate(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** "expires in N days" / "expires today" / "expired". */
function expiryLabel(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const days = Math.ceil((t - Date.now()) / (24 * 60 * 60 * 1000));
  if (days < 0) return 'expired';
  if (days === 0) return 'expires today';
  return `expires in ${days} day${days === 1 ? '' : 's'}`;
}

/**
 * My Data (dev plan M3.4 / PRD §8.1, §8.4). Self-service screen where a signed-in
 * member reviews and deletes the reference selfies they've saved for Find Me.
 * Deleting cascades server-side (GCS object + Firestore record).
 */
export function MyData(): JSX.Element {
  const [uploads, setUploads] = useState<ReferenceUpload[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [purgeArmed, setPurgeArmed] = useState(false);
  const [purging, setPurging] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await apiGet<ListReferencesResponse>('/api/findme/uploads');
      setUploads(r.uploads);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load your saved photos.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function remove(uploadId: string): Promise<void> {
    setBusyId(uploadId);
    setNotice(null);
    try {
      await apiDelete<DeleteReferenceResponse>(`/api/findme/uploads/${uploadId}`);
      setUploads((prev) => (prev ?? []).filter((u) => u.uploadId !== uploadId));
      setNotice('Photo deleted.');
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        // Already gone — drop it from the list anyway.
        setUploads((prev) => (prev ?? []).filter((u) => u.uploadId !== uploadId));
      } else {
        setNotice(e instanceof Error ? e.message : 'Could not delete that photo.');
      }
    } finally {
      setBusyId(null);
      setConfirmId(null);
    }
  }

  async function purgeAll(): Promise<void> {
    setPurging(true);
    setNotice(null);
    try {
      const r = await apiDelete<DeleteMyDataResponse>('/api/findme/me/data');
      setUploads([]);
      const { references, matchRuns, feedback } = r.deleted;
      setNotice(
        `All your Find Me data was deleted (${references} saved photo${references === 1 ? '' : 's'}, ` +
          `${matchRuns} search${matchRuns === 1 ? '' : 'es'}, ${feedback} feedback vote${feedback === 1 ? '' : 's'}).`,
      );
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Could not delete your data.');
    } finally {
      setPurging(false);
      setPurgeArmed(false);
    }
  }

  if (error) return <p className="error-text">Could not load your data: {error}</p>;

  return (
    <div>
      <h2>My data</h2>
      <p className="muted">
        Reference selfies you&rsquo;ve saved for Find Me. They auto-delete on the date shown — or
        remove any of them now.
      </p>
      {notice && <p className="muted">{notice}</p>}

      {uploads === null ? (
        <p className="muted">Loading…</p>
      ) : uploads.length === 0 ? (
        <p className="muted">You have no saved photos.</p>
      ) : (
        <ul className="mydata-grid">
          {uploads.map((u) => (
            <li key={u.uploadId} className="mydata-card">
              <img className="mydata-thumb" src={u.url} alt="Saved reference selfie" />
              <div className="mydata-meta">
                <span className="event-stat">Saved {fmtDate(u.createdAt)}</span>
                <span className="muted event-stat">{expiryLabel(u.expiresAt)}</span>
                <span className="badge">{u.mode === 'person' ? 'Outfit' : 'Face'}</span>
              </div>
              {confirmId === u.uploadId ? (
                <div className="mydata-confirm">
                  <span className="event-stat">Delete this photo?</span>
                  <button
                    className="btn btn-light btn-sm"
                    onClick={() => void remove(u.uploadId)}
                    disabled={busyId === u.uploadId}
                  >
                    {busyId === u.uploadId ? 'Deleting…' : 'Yes, delete'}
                  </button>
                  <button
                    className="btn btn-light btn-sm"
                    onClick={() => setConfirmId(null)}
                    disabled={busyId === u.uploadId}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button className="btn btn-light btn-sm" onClick={() => setConfirmId(u.uploadId)}>
                  Delete
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <section className="danger-zone">
        <h3>Delete everything</h3>
        <p className="muted">
          Permanently delete all your Find Me data — saved photos, search history, and feedback.
          This revokes your consent and can&rsquo;t be undone.
        </p>
        {purgeArmed ? (
          <div className="mydata-confirm">
            <span className="event-stat">Delete all your Find Me data?</span>
            <button className="btn btn-danger btn-sm" onClick={() => void purgeAll()} disabled={purging}>
              {purging ? 'Deleting…' : 'Yes, delete everything'}
            </button>
            <button className="btn btn-light btn-sm" onClick={() => setPurgeArmed(false)} disabled={purging}>
              Cancel
            </button>
          </div>
        ) : (
          <button className="btn btn-danger btn-sm" onClick={() => setPurgeArmed(true)}>
            Delete all my data
          </button>
        )}
      </section>
    </div>
  );
}
