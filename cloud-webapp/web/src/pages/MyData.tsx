import { useCallback, useEffect, useState } from 'react';
import type {
  ListReferencesResponse,
  ReferenceUpload,
  DeleteReferenceResponse,
  DeleteMyDataResponse,
} from '@cloud-webapp/shared';
import { apiGet, apiDelete, ApiError } from '../lib/api.js';
import { useStrings } from '../lib/i18n.js';

const STR = {
  en: {
    loadSavedError: 'Could not load your saved photos.',
    photoDeleted: 'Photo deleted.',
    deletePhotoError: 'Could not delete that photo.',
    purgedAll: (refs: number, runs: number, fb: number): string =>
      `All your Find Me data was deleted (${refs} saved photo${refs === 1 ? '' : 's'}, ` +
      `${runs} search${runs === 1 ? '' : 'es'}, ${fb} feedback vote${fb === 1 ? '' : 's'}).`,
    purgeError: 'Could not delete your data.',
    loadDataError: 'Could not load your data',
    title: 'My data',
    intro:
      'Reference selfies you’ve saved for Find Me. They auto-delete on the date shown — or remove any of them now.',
    loading: 'Loading…',
    noneSaved: 'You have no saved photos.',
    savedSelfieAlt: 'Saved reference selfie',
    saved: (date: string): string => `Saved ${date}`,
    outfit: 'Outfit',
    face: 'Face',
    deletePhotoQ: 'Delete this photo?',
    deleting: 'Deleting…',
    yesDelete: 'Yes, delete',
    cancel: 'Cancel',
    delete: 'Delete',
    dangerTitle: 'Delete everything',
    dangerIntro:
      'Permanently delete all your Find Me data — saved photos, search history, and feedback. This revokes your consent and can’t be undone.',
    deleteAllQ: 'Delete all your Find Me data?',
    yesDeleteEverything: 'Yes, delete everything',
    deleteAllMyData: 'Delete all my data',
    expiry: {
      expired: 'expired',
      today: 'expires today',
      inDays: (n: number): string => `expires in ${n} day${n === 1 ? '' : 's'}`,
    },
  },
  zh: {
    loadSavedError: '无法加载您保存的照片。',
    photoDeleted: '照片已删除。',
    deletePhotoError: '无法删除该照片。',
    purgedAll: (refs: number, runs: number, fb: number): string =>
      `已删除您的全部人脸识别数据（${refs} 张已保存照片、${runs} 次搜索、${fb} 次反馈）。`,
    purgeError: '无法删除您的数据。',
    loadDataError: '无法加载您的数据',
    title: '我的数据',
    intro:
      '您为人脸识别保存的参考自拍。它们会在所示日期自动删除，您也可以立即移除其中任意一张。',
    loading: '加载中…',
    noneSaved: '您没有已保存的照片。',
    savedSelfieAlt: '已保存的参考自拍',
    saved: (date: string): string => `保存于 ${date}`,
    outfit: '服装',
    face: '人脸',
    deletePhotoQ: '删除这张照片？',
    deleting: '删除中…',
    yesDelete: '是，删除',
    cancel: '取消',
    delete: '删除',
    dangerTitle: '删除全部数据',
    dangerIntro:
      '永久删除您的全部人脸识别数据——已保存的照片、搜索记录和反馈。此操作将撤销您的同意，且无法撤销。',
    deleteAllQ: '删除您的全部人脸识别数据？',
    yesDeleteEverything: '是，全部删除',
    deleteAllMyData: '删除我的全部数据',
    expiry: {
      expired: '已过期',
      today: '今天到期',
      inDays: (n: number): string => `${n} 天后到期`,
    },
  },
};

type ExpiryStrings = (typeof STR)['en']['expiry'];

function fmtDate(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** "expires in N days" / "expires today" / "expired" in the current language. */
function expiryLabel(iso: string, expiry: ExpiryStrings): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const days = Math.ceil((t - Date.now()) / (24 * 60 * 60 * 1000));
  if (days < 0) return expiry.expired;
  if (days === 0) return expiry.today;
  return expiry.inDays(days);
}

/**
 * My Data (dev plan M3.4 / PRD §8.1, §8.4). Self-service screen where a signed-in
 * member reviews and deletes the reference selfies they've saved for Find Me.
 * Deleting cascades server-side (GCS object + Firestore record).
 */
export function MyData(): JSX.Element {
  const t = useStrings(STR);
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
      setError(e instanceof Error ? e.message : STR.en.loadSavedError);
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
      setNotice(t.photoDeleted);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        // Already gone — drop it from the list anyway.
        setUploads((prev) => (prev ?? []).filter((u) => u.uploadId !== uploadId));
      } else {
        setNotice(e instanceof Error ? e.message : t.deletePhotoError);
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
      setNotice(t.purgedAll(references, matchRuns, feedback));
    } catch (e) {
      setNotice(e instanceof Error ? e.message : t.purgeError);
    } finally {
      setPurging(false);
      setPurgeArmed(false);
    }
  }

  if (error) return <p className="error-text">{t.loadDataError}：{error}</p>;

  return (
    <div>
      <h2>{t.title}</h2>
      <p className="muted">{t.intro}</p>
      {notice && <p className="muted">{notice}</p>}

      {uploads === null ? (
        <p className="muted">{t.loading}</p>
      ) : uploads.length === 0 ? (
        <p className="muted">{t.noneSaved}</p>
      ) : (
        <ul className="mydata-grid">
          {uploads.map((u) => (
            <li key={u.uploadId} className="mydata-card">
              <img className="mydata-thumb" src={u.url} alt={t.savedSelfieAlt} />
              <div className="mydata-meta">
                <span className="event-stat">{t.saved(fmtDate(u.createdAt))}</span>
                <span className="muted event-stat">{expiryLabel(u.expiresAt, t.expiry)}</span>
                <span className="badge">{u.mode === 'person' ? t.outfit : t.face}</span>
              </div>
              {confirmId === u.uploadId ? (
                <div className="mydata-confirm">
                  <span className="event-stat">{t.deletePhotoQ}</span>
                  <button
                    className="btn btn-light btn-sm"
                    onClick={() => void remove(u.uploadId)}
                    disabled={busyId === u.uploadId}
                  >
                    {busyId === u.uploadId ? t.deleting : t.yesDelete}
                  </button>
                  <button
                    className="btn btn-light btn-sm"
                    onClick={() => setConfirmId(null)}
                    disabled={busyId === u.uploadId}
                  >
                    {t.cancel}
                  </button>
                </div>
              ) : (
                <button className="btn btn-light btn-sm" onClick={() => setConfirmId(u.uploadId)}>
                  {t.delete}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <section className="danger-zone">
        <h3>{t.dangerTitle}</h3>
        <p className="muted">{t.dangerIntro}</p>
        {purgeArmed ? (
          <div className="mydata-confirm">
            <span className="event-stat">{t.deleteAllQ}</span>
            <button className="btn btn-danger btn-sm" onClick={() => void purgeAll()} disabled={purging}>
              {purging ? t.deleting : t.yesDeleteEverything}
            </button>
            <button className="btn btn-light btn-sm" onClick={() => setPurgeArmed(false)} disabled={purging}>
              {t.cancel}
            </button>
          </div>
        ) : (
          <button className="btn btn-danger btn-sm" onClick={() => setPurgeArmed(true)}>
            {t.deleteAllMyData}
          </button>
        )}
      </section>
    </div>
  );
}
