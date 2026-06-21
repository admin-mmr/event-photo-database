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

import { uploadFileResumable, AbortError, type UploadResult } from '../lib/resumableUpload.js';
import { apiPost } from '../lib/api.js';

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

type Phase = 'idle' | 'uploading' | 'done';

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

export function VolunteerUpload(): JSX.Element {
  const { token = '' } = useParams();
  const [items, setItems] = useState<Item[]>([]);
  const [photographerName, setPhotographerName] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);

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
      const res = await apiPost<{ ok: true; message: string }>('/api/volunteer/upload/complete', {
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
      setPhase('done');
    } catch (err) {
      setFatalError(err instanceof Error ? err.message : String(err));
      setPhase('idle');
    }
  }, [items, phase, token, batchId, patch, photographerName]);

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
          <div style={{ fontSize: 40 }}>📁</div>
          <div style={{ color: '#1b5e20', fontWeight: 600 }}>Drag &amp; drop photos and videos here</div>
          <div className="muted">{items.length} file{items.length === 1 ? '' : 's'} selected</div>
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
          <strong>✅ Done!</strong>
          <p style={{ margin: '4px 0 0' }}>{receipt}</p>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button
            className="btn btn-primary"
            disabled={items.length === 0 || phase === 'uploading'}
            onClick={() => void startUpload()}
          >
            {phase === 'uploading' ? 'Uploading…' : `Upload ${items.length || ''} file${items.length === 1 ? '' : 's'}`}
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
