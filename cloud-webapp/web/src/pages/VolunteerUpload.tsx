/**
 * VolunteerUpload.tsx — public resumable upload page (route /upload/:token).
 *
 * Replaces the gas-app "DO NOT close this window — all photos will be lost"
 * flow. Because uploads are resumable (resumableUpload.ts + uploadDb.ts), a
 * dropped connection or a closed tab no longer loses the batch: re-selecting
 * the same files picks up from the last committed byte. The on-page warning is
 * reworded accordingly.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';

import type {
  CompleteUploadResponse,
  UploadBatchPhase,
  UploadBatchStatusResponse,
} from '@cloud-webapp/shared';

import { uploadFileResumable, AbortError, type UploadResult } from '../lib/resumableUpload.js';
import { apiGet, apiPost } from '../lib/api.js';

const CONCURRENCY = 3;
const ACCEPTED = new Set([
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/heif',
  'image/webp',
  'video/mp4',
  'video/quicktime',
]);

type FileStatus = 'pending' | 'uploading' | 'done' | 'error' | 'skipped';

interface Item {
  file: File;
  status: FileStatus;
  sent: number;
  resumedFrom?: number;
  error?: string;
  result?: UploadResult;
}

// idle → uploading (bytes → cloud, safe to close tab) → finalizing (saving to
// Drive + queuing indexing) → done (received; gallery appears after indexing).
type Phase = 'idle' | 'uploading' | 'finalizing' | 'done';

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtEta(sec: number): string {
  if (!isFinite(sec) || sec <= 0) return '';
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m > 0 ? `~${m} min ${s} sec remaining` : `~${s} sec remaining`;
}

/**
 * Touch device (phone/tablet) detection. We feature-detect the *interaction
 * model* rather than sniff the user agent: a coarse pointer with no hover means
 * there's no drag-and-drop, so the dropzone should say "tap to choose" instead.
 * `maxTouchPoints` is a fallback for browsers without the media query.
 */
const IS_TOUCH =
  typeof window !== 'undefined' &&
  ((typeof window.matchMedia === 'function' &&
    window.matchMedia('(hover: none) and (pointer: coarse)').matches) ||
    (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0));

export function VolunteerUpload(): JSX.Element {
  const { token = '' } = useParams();
  const [items, setItems] = useState<Item[]>([]);
  const [photographerName, setPhotographerName] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<string[]>([]);
  // Backend pipeline phase polled from the status endpoint after the bytes are
  // in the cloud (saving → indexing → done/ready). Drives the post-upload line.
  const [serverPhase, setServerPhase] = useState<UploadBatchPhase | null>(null);

  const batchId = useMemo(() => crypto.randomUUID(), []);
  const abortRef = useRef<AbortController | null>(null);
  const startRef = useRef<number>(0);

  const totalBytes = useMemo(() => items.reduce((a, i) => a + i.file.size, 0), [items]);
  const sentBytes = useMemo(() => items.reduce((a, i) => a + i.sent, 0), [items]);

  const eta = useMemo(() => {
    if (phase !== 'uploading' || sentBytes === 0) return '';
    const elapsed = (Date.now() - startRef.current) / 1000;
    const rate = sentBytes / elapsed; // bytes/sec
    return fmtEta(rate > 0 ? (totalBytes - sentBytes) / rate : Infinity);
  }, [phase, sentBytes, totalBytes]);

  const addFiles = useCallback((files: FileList | null) => {
    if (!files) return;
    const next: Item[] = Array.from(files).map((file) => ({ file, status: 'pending', sent: 0 }));
    setItems((prev) => [...prev, ...next]);
  }, []);

  const patch = useCallback((idx: number, p: Partial<Item>) => {
    setItems((prev) => prev.map((it, i) => (i === idx ? { ...it, ...p } : it)));
  }, []);

  // Poll the batch status so the page reflects the background pipeline (saving →
  // indexing → done). Capped so it can't poll forever; stops on a terminal phase.
  // Forward-compatible with step 3 (a worker advancing the same doc to `ready`).
  const pollStatus = useCallback(
    async (id: string): Promise<void> => {
      for (let i = 0; i < 20; i += 1) {
        try {
          const s = await apiGet<UploadBatchStatusResponse>(
            `/api/volunteer/upload/status/${encodeURIComponent(id)}?token=${encodeURIComponent(token)}`,
          );
          setServerPhase(s.phase);
          if (s.phase === 'done' || s.phase === 'ready' || s.phase === 'error') return;
        } catch {
          /* transient — keep trying until the cap */
        }
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 3000));
      }
    },
    [token],
  );

  const startUpload = useCallback(async () => {
    if (items.length === 0 || phase === 'uploading') return;
    setPhase('uploading');
    setFatalError(null);
    startRef.current = Date.now();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    const results: UploadResult[] = [];
    let nextIdx = 0;

    async function worker(): Promise<void> {
      while (nextIdx < items.length) {
        const idx = nextIdx++;
        const current = items[idx];
        if (!current) continue;
        const { file } = current;
        const mimeType = file.type || '';
        if (mimeType && !ACCEPTED.has(mimeType)) {
          patch(idx, { status: 'skipped', error: 'Unsupported file type' });
          continue;
        }
        patch(idx, { status: 'uploading' });
        try {
          const result = await uploadFileResumable(
            token,
            batchId,
            file,
            mimeType,
            {
              onProgress: (sent) => patch(idx, { sent }),
              onResumed: (from) => patch(idx, { resumedFrom: from }),
              signal: ctrl.signal,
            },
            photographerName,
          );
          patch(idx, { status: 'done', sent: file.size, result });
          results.push(result);
        } catch (err) {
          if (err instanceof AbortError) return;
          patch(idx, { status: 'error', error: err instanceof Error ? err.message : String(err) });
        }
      }
    }

    try {
      await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
      if (ctrl.signal.aborted) {
        setPhase('idle');
        return;
      }
      if (results.length === 0) {
        setFatalError('No files were uploaded. You can retry — completed files will not re-upload.');
        setPhase('idle');
        return;
      }
      // Bytes are now safely in the cloud; this step files them into Drive and
      // queues indexing. Show it as its own phase rather than a blank wait.
      setPhase('finalizing');
      const res = await apiPost<CompleteUploadResponse>('/api/volunteer/upload/complete', {
        token,
        batchId,
        items: results.map((r) => ({
          uploadId: r.uploadId,
          objectName: r.objectName,
          fileName: items.find((i) => i.result?.uploadId === r.uploadId)?.file.name ?? r.objectName,
          bytes: r.bytes,
        })),
      });
      setReceipt(res.message);
      setSkipped(res.skippedDuplicateNames ?? []);
      setPhase('done');
      void pollStatus(batchId);
    } catch (err) {
      setFatalError(err instanceof Error ? err.message : String(err));
      setPhase('idle');
    }
  }, [items, phase, token, batchId, patch, photographerName, pollStatus]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const pct = totalBytes > 0 ? Math.round((sentBytes / totalBytes) * 100) : 0;

  return (
    <div className="card" style={{ maxWidth: 640, margin: '0 auto', padding: 20 }}>
      <h2>📸 Upload Photos</h2>

      {phase === 'uploading' && (
        <div
          role="status"
          style={{ background: '#e8f5e9', border: '1px solid #a5d6a7', borderRadius: 8, padding: 12, margin: '12px 0' }}
        >
          <strong>Uploading…</strong> You can safely close this tab and come back —
          reopening this page and re-selecting the same files resumes where you left off.
          {eta && <div style={{ marginTop: 4, color: '#555' }}>{eta}</div>}
        </div>
      )}

      {phase === 'finalizing' && (
        <div
          role="status"
          style={{ background: '#e8f5e9', border: '1px solid #a5d6a7', borderRadius: 8, padding: 12, margin: '12px 0' }}
        >
          <strong>Saving to the event library…</strong> Your files are safely uploaded — we&rsquo;re
          filing them into Google Drive and queuing them for indexing.
          <div className="muted" style={{ marginTop: 4 }}>
            文件已安全上传，正在保存到 Google Drive 并排队建立索引…
          </div>
        </div>
      )}

      {phase !== 'done' && (
        <div style={{ margin: '12px 0' }}>
          <label htmlFor="photographer-name" style={{ display: 'block', fontWeight: 600, marginBottom: 4 }}>
            Your name <span className="muted" style={{ fontWeight: 400 }}>(for photo credit — optional)</span>
          </label>
          <input
            id="photographer-name"
            type="text"
            value={photographerName}
            onChange={(e) => setPhotographerName(e.target.value)}
            placeholder="e.g. Jane Doe"
            disabled={phase === 'uploading'}
            maxLength={120}
            style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid #ccc', boxSizing: 'border-box' }}
          />
        </div>
      )}

      {phase !== 'done' && (
        <label
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            addFiles(e.dataTransfer.files);
          }}
          style={{
            display: 'block',
            border: '2px dashed #66bb6a',
            borderRadius: 12,
            padding: 32,
            textAlign: 'center',
            cursor: 'pointer',
            background: '#fafffa',
          }}
        >
          <div style={{ fontSize: 40 }}>{IS_TOUCH ? '🖼️' : '📁'}</div>
          <div style={{ color: '#1b5e20', fontWeight: 600 }}>
            {IS_TOUCH ? 'Tap to add photos or videos' : 'Drag & drop photos and videos here'}
          </div>
          <div style={{ color: '#1b5e20', fontWeight: 600 }}>
            {IS_TOUCH ? '点按添加照片或视频' : '拖放照片和视频到此处'}
          </div>
          <div className="muted">
            {IS_TOUCH
              ? 'Choose from your Photos or Files · 可从「照片」或「文件」中选择'
              : 'or click to choose · 或点击选择'}
          </div>
          <div className="muted">
            {items.length} file{items.length === 1 ? '' : 's'} selected · 已选择 {items.length} 个文件
          </div>
          <input
            type="file"
            multiple
            accept="image/*,video/mp4,video/quicktime"
            style={{ display: 'none' }}
            onChange={(e) => addFiles(e.target.files)}
            disabled={phase === 'uploading'}
          />
        </label>
      )}

      {items.length > 0 && (
        <>
          <div style={{ margin: '12px 0' }}>
            <div style={{ height: 8, background: '#eee', borderRadius: 4, overflow: 'hidden' }}>
              <div style={{ width: `${pct}%`, height: '100%', background: '#43a047', transition: 'width .2s' }} />
            </div>
            <div className="muted" style={{ marginTop: 4 }}>
              {pct}% · {fmtBytes(sentBytes)} / {fmtBytes(totalBytes)}
            </div>
          </div>

          <ul style={{ listStyle: 'none', padding: 0, maxHeight: 260, overflow: 'auto' }}>
            {items.map((it, i) => (
              <li
                key={`${it.file.name}-${i}`}
                style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid #f0f0f0' }}
              >
                <span>
                  {statusIcon(it.status)} {it.file.name}
                  {it.resumedFrom ? <span className="muted"> (resumed)</span> : null}
                  {it.error ? <span style={{ color: '#c62828' }}> — {it.error}</span> : null}
                </span>
                <span className="muted">{fmtBytes(it.file.size)}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {fatalError && <p style={{ color: '#c62828' }}>{fatalError}</p>}

      {phase === 'done' ? (
        <div style={{ background: '#e8f5e9', borderRadius: 8, padding: 16, marginTop: 12 }}>
          <strong>✅ Upload received!</strong>
          <p style={{ margin: '4px 0 0' }}>{receipt}</p>
          <p style={{ margin: '8px 0 0', color: '#555' }}>
            {serverPhase === 'saving'
              ? 'Saving your photos to the event library… · 正在保存到相册…'
              : serverPhase === 'error'
                ? 'Saved to the cloud, but the library step hit a snag — an admin will reconcile it. · 已上传到云端，保存步骤出现问题，管理员会处理。'
                : 'Your photos are saved. They’ll appear in the event gallery in a few minutes, once indexing finishes. · 照片已保存，索引完成后几分钟内即可在相册中查看。'}
          </p>
          {skipped.length > 0 && (
            <details style={{ marginTop: 10 }}>
              <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
                {skipped.length} already uploaded — skipped · {skipped.length} 个已上传，已跳过
              </summary>
              <ul style={{ margin: '6px 0 0', paddingLeft: 20 }}>
                {skipped.map((n) => (
                  <li key={n} className="muted">
                    {n}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button
            className="btn btn-primary"
            disabled={items.length === 0 || phase === 'uploading' || phase === 'finalizing'}
            onClick={() => void startUpload()}
          >
            {phase === 'uploading'
              ? 'Uploading…'
              : phase === 'finalizing'
                ? 'Finalizing…'
                : `Upload ${items.length || ''} file${items.length === 1 ? '' : 's'}`}
          </button>
          {phase === 'uploading' && (
            <button className="btn btn-light" onClick={cancel}>
              Cancel
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function statusIcon(s: FileStatus): string {
  switch (s) {
    case 'uploading':
      return '⏫';
    case 'done':
      return '✅';
    case 'error':
      return '❌';
    case 'skipped':
      return '⏭️';
    default:
      return '⏳';
  }
}
