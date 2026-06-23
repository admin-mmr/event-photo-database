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

/** "expires in N days" / "expires today" / "expired" (bilingual). */
function expiryLabel(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const days = Math.ceil((t - Date.now()) / (24 * 60 * 60 * 1000));
  if (days < 0) return 'expired · 已过期';
  if (days === 0) return 'expires today · 今天到期';
  return `expires in ${days} day${days === 1 ? '' : 's'} · ${days} 天后到期`;
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
      setError(e instanceof Error ? e.message : 'Could not load your saved photos. · 无法加载您保存的照片。');
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
      setNotice('Photo deleted. · 照片已删除。');
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        // Already gone — drop it from the list anyway.
        setUploads((prev) => (prev ?? []).filter((u) => u.uploadId !== uploadId));
      } else {
        setNotice(e instanceof Error ? e.message : 'Could not delete that photo. · 无法删除该照片。');
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
          `${matchRuns} search${matchRuns === 1 ? '' : 'es'}, ${feedback} feedback vote${feedback === 1 ? '' : 's'}). · ` +
          `已删除您的全部「找到我」数据（${references} 张已保存照片、${matchRuns} 次搜索、${feedback} 次反馈）。`,
      );
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Could not delete your data. · 无法删除您的数据。');
    } finally {
      setPurging(false);
      setPurgeArmed(false);
    }
  }

  if (error) return <p className="error-text">Could not load your data · 无法加载您的数据：{error}</p>;

  return (
    <div>
      <h2>My data · 我的数据</h2>
      <p className="muted">
        Reference selfies you&rsquo;ve saved for Find Me. They auto-delete on the date shown — or
        remove any of them now. · 您为「找到我」保存的参考自拍。它们会在所示日期自动删除，您也可以立即移除其中任意一张。
      </p>
      {notice && <p className="muted">{notice}</p>}

      {uploads === null ? (
        <p className="muted">Loading… · 加载中…</p>
      ) : uploads.length === 0 ? (
        <p className="muted">You have no saved photos. · 您没有已保存的照片。</p>
      ) : (
        <ul className="mydata-grid">
          {uploads.map((u) => (
            <li key={u.uploadId} className="mydata-card">
              <img className="mydata-thumb" src={u.url} alt="Saved reference selfie · 已保存的参考自拍" />
              <div className="mydata-meta">
                <span className="event-stat">Saved {fmtDate(u.createdAt)} · 保存于 {fmtDate(u.createdAt)}</span>
                <span className="muted event-stat">{expiryLabel(u.expiresAt)}</span>
                <span className="badge">{u.mode === 'person' ? 'Outfit · 服装' : 'Face · 人脸'}</span>
              </div>
              {confirmId === u.uploadId ? (
                <div className="mydata-confirm">
                  <span className="event-stat">Delete this photo? · 删除这张照片？</span>
                  <button
                    className="btn btn-light btn-sm"
                    onClick={() => void remove(u.uploadId)}
                    disabled={busyId === u.uploadId}
                  >
                    {busyId === u.uploadId ? 'Deleting… · 删除中…' : 'Yes, delete · 是，删除'}
                  </button>
                  <button
                    className="btn btn-light btn-sm"
                    onClick={() => setConfirmId(null)}
                    disabled={busyId === u.uploadId}
                  >
                    Cancel · 取消
                  </button>
                </div>
              ) : (
                <button className="btn btn-light btn-sm" onClick={() => setConfirmId(u.uploadId)}>
                  Delete · 删除
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <section className="danger-zone">
        <h3>Delete everything · 删除全部数据</h3>
        <p className="muted">
          Permanently delete all your Find Me data — saved photos, search history, and feedback.
          This revokes your consent and can&rsquo;t be undone. ·
          永久删除您的全部「找到我」数据——已保存的照片、搜索记录和反馈。此操作将撤销您的同意，且无法撤销。
        </p>
        {purgeArmed ? (
          <div className="mydata-confirm">
            <span className="event-stat">Delete all your Find Me data? · 删除您的全部「找到我」数据？</span>
            <button className="btn btn-danger btn-sm" onClick={() => void purgeAll()} disabled={purging}>
              {purging ? 'Deleting… · 删除中…' : 'Yes, delete everything · 是，全部删除'}
            </button>
            <button className="btn btn-light btn-sm" onClick={() => setPurgeArmed(false)} disabled={purging}>
              Cancel · 取消
            </button>
          </div>
        ) : (
          <button className="btn btn-danger btn-sm" onClick={() => setPurgeArmed(true)}>
            Delete all my data · 删除我的全部数据
          </button>
        )}
      </section>
    </div>
  );
}
