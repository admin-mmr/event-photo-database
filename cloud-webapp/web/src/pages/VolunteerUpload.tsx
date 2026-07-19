/**
 * VolunteerUpload.tsx — public resumable upload page (route /upload/:token).
 *
 * Replaces the gas-app "DO NOT close this window — all photos will be lost"
 * flow. Because uploads are resumable (resumableUpload.ts + uploadDb.ts), a
 * dropped connection or a closed tab no longer loses the batch: re-selecting
 * the same files picks up from the last committed byte. The on-page warning is
 * reworded accordingly.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';

import type {
  CompleteUploadResponse,
  UploadBatchPhase,
  UploadBatchStatusResponse,
} from '@cloud-webapp/shared';

import { uploadFileResumable, AbortError, type UploadResult } from '../lib/resumableUpload.js';
import { apiGet, apiPost } from '../lib/api.js';
import { useStrings } from '../lib/i18n.js';

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

const STR = {
  en: {
    heading: '📸 Upload Photos',
    uploadingTitle: 'Uploading…',
    uploadingBody:
      'You can safely close this tab and come back — reopening this page and re-selecting the same files resumes where you left off.',
    finalizingTitle: 'Saving to the event library…',
    finalizingBody:
      'Your files are safely uploaded — we’re filing them into Google Drive and queuing them for indexing.',
    finalizingBodyZh: '文件已安全上传，正在保存到 Google Drive 并排队建立索引…',
    nameLabel: 'Your name',
    nameHint: '(for photo credit — optional)',
    namePlaceholder: 'e.g. Jane Doe',
    dropzoneTitleTouch: 'Tap to add photos or videos',
    dropzoneTitleDesktop: 'Drag & drop photos and videos here',
    dropzoneTitleTouchZh: '点按添加照片或视频',
    dropzoneTitleDesktopZh: '拖放照片和视频到此处',
    dropzoneHintTouch: 'Choose from your Photos or Files',
    dropzoneHintDesktop: 'or click to choose',
    filesSelected: (n: number): string => `${n} file${n === 1 ? '' : 's'} selected`,
    unsupportedType: 'Unsupported file type',
    noFilesUploaded: 'No files were uploaded. You can retry — completed files will not re-upload.',
    resumed: '(resumed)',
    uploadReceived: '✅ Upload received!',
    statusReceived: 'Queued — saving your photos shortly…',
    statusSaving: 'Saving your photos to the event library…',
    statusError:
      'Saved to the cloud, but the library step hit a snag — an admin will reconcile it.',
    statusDone:
      'Your photos are saved. They’ll appear in the event gallery in a few minutes, once indexing finishes.',
    skippedSummary: (n: number): string => `${n} already uploaded — skipped`,
    btnUploading: 'Uploading…',
    btnFinalizing: 'Finalizing…',
    btnUpload: (n: number): string => `Upload ${n || ''} file${n === 1 ? '' : 's'}`,
    cancel: 'Cancel',
    retry: 'Retry',
    etaMinSec: (m: number, s: number): string => `~${m} min ${s} sec remaining`,
    etaSec: (s: number): string => `~${s} sec remaining`,
  },
  zh: {
    heading: '📸 上传照片',
    uploadingTitle: '上传中…',
    uploadingBody: '您可以放心关闭此标签页稍后再来——重新打开此页面并重新选择相同的文件即可从上次中断处继续。',
    finalizingTitle: '正在保存到活动相册…',
    finalizingBody: '您的文件已安全上传——我们正在将它们归档到 Google Drive 并排队建立索引。',
    finalizingBodyZh: '文件已安全上传，正在保存到 Google Drive 并排队建立索引…',
    nameLabel: '您的姓名',
    nameHint: '（用于照片署名——可选）',
    namePlaceholder: '例如 张三',
    dropzoneTitleTouch: '点按添加照片或视频',
    dropzoneTitleDesktop: '拖放照片和视频到此处',
    dropzoneTitleTouchZh: '点按添加照片或视频',
    dropzoneTitleDesktopZh: '拖放照片和视频到此处',
    dropzoneHintTouch: '可从「照片」或「文件」中选择',
    dropzoneHintDesktop: '或点击选择',
    filesSelected: (n: number): string => `已选择 ${n} 个文件`,
    unsupportedType: '不支持的文件类型',
    noFilesUploaded: '没有文件被上传。您可以重试——已完成的文件不会重新上传。',
    resumed: '（已续传）',
    uploadReceived: '✅ 已收到上传！',
    statusReceived: '已接收，正在排队保存…',
    statusSaving: '正在保存到相册…',
    statusError: '已上传到云端，保存步骤出现问题，管理员会处理。',
    statusDone: '照片已保存，索引完成后几分钟内即可在相册中查看。',
    skippedSummary: (n: number): string => `${n} 个已上传，已跳过`,
    btnUploading: '上传中…',
    btnFinalizing: '正在完成…',
    btnUpload: (n: number): string => `上传 ${n || ''} 个文件`,
    cancel: '取消',
    retry: '重试',
    etaMinSec: (m: number, s: number): string => `约剩 ${m} 分 ${s} 秒`,
    etaSec: (s: number): string => `约剩 ${s} 秒`,
  },
};

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

function fmtEta(sec: number, t: typeof STR.en): string {
  if (!isFinite(sec) || sec <= 0) return '';
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m > 0 ? t.etaMinSec(m, s) : t.etaSec(s);
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
  const t = useStrings(STR);
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
  // Successful uploads accumulate here across upload rounds so the finalize
  // (/complete) step can be retried without re-uploading already-sent bytes.
  const resultsRef = useRef<UploadResult[]>([]);
  // Auto-start is "armed" only by a fresh file add (drop/pick). This is what
  // makes Cancel stick: aborting leaves items pending but disarms, so the
  // uploader doesn't immediately restart them.
  const armedRef = useRef(false);
  // Latest items, readable synchronously inside the async upload loop so a round
  // can pick up files dropped after the run started.
  const itemsRef = useRef<Item[]>(items);
  itemsRef.current = items;

  const totalBytes = useMemo(() => items.reduce((a, i) => a + i.file.size, 0), [items]);
  const sentBytes = useMemo(() => items.reduce((a, i) => a + i.sent, 0), [items]);

  const eta = useMemo(() => {
    if (phase !== 'uploading' || sentBytes === 0) return '';
    const elapsed = (Date.now() - startRef.current) / 1000;
    const rate = sentBytes / elapsed; // bytes/sec
    return fmtEta(rate > 0 ? (totalBytes - sentBytes) / rate : Infinity, t);
  }, [phase, sentBytes, totalBytes, t]);

  const addFiles = useCallback((files: FileList | null) => {
    if (!files) return;
    const next: Item[] = Array.from(files).map((file) => ({ file, status: 'pending', sent: 0 }));
    if (next.length === 0) return;
    setItems((prev) => [...prev, ...next]);
    // Arm the auto-start effect: a fresh add always means "upload these".
    armedRef.current = true;
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
          // In the background path the skipped duplicates are only known after
          // the worker runs, so surface them from the status doc when present.
          if (s.skippedDuplicateNames?.length) setSkipped(s.skippedDuplicateNames);
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

  // Bytes are safely in the cloud by now; file them into Drive + queue indexing.
  // Split out from the upload loop so it can be retried on its own (the bytes
  // don't need re-sending) via the Retry button.
  const finalize = useCallback(async (): Promise<void> => {
    const results = resultsRef.current;
    if (results.length === 0) {
      setFatalError(t.noFilesUploaded);
      setPhase('idle');
      return;
    }
    setPhase('finalizing');
    try {
      const res = await apiPost<CompleteUploadResponse>('/api/volunteer/upload/complete', {
        token,
        batchId,
        items: results.map((r) => ({
          uploadId: r.uploadId,
          objectName: r.objectName,
          fileName: itemsRef.current.find((i) => i.result?.uploadId === r.uploadId)?.file.name ?? r.objectName,
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
  }, [token, batchId, pollStatus, t]);

  const runUploads = useCallback(async () => {
    if (phase === 'uploading' || phase === 'finalizing') return;
    // Nothing new to send — if a prior run already uploaded bytes but the
    // finalize step failed, just retry finalize (Retry button after an error).
    if (!itemsRef.current.some((it) => it.status === 'pending')) {
      if (resultsRef.current.length > 0) {
        setFatalError(null);
        void finalize();
      }
      return;
    }
    setFatalError(null);
    setPhase('uploading');
    if (startRef.current === 0) startRef.current = Date.now();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    // One pass over the files that are pending right now. Runs CONCURRENCY
    // workers over that snapshot; files dropped mid-pass are caught by the
    // outer do/while, which starts another round.
    async function round(): Promise<void> {
      const pending = itemsRef.current
        .map((it, i) => ({ it, i }))
        .filter((x) => x.it.status === 'pending');
      let cursor = 0;

      async function worker(): Promise<void> {
        while (cursor < pending.length) {
          const entry = pending[cursor];
          cursor += 1;
          if (!entry) continue;
          const { it, i: idx } = entry;
          const { file } = it;
          const mimeType = file.type || '';
          if (mimeType && !ACCEPTED.has(mimeType)) {
            patch(idx, { status: 'skipped', error: t.unsupportedType });
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
            resultsRef.current.push(result);
          } catch (err) {
            if (err instanceof AbortError) return;
            patch(idx, { status: 'error', error: err instanceof Error ? err.message : String(err) });
          }
        }
      }

      await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
    }

    try {
      do {
        // eslint-disable-next-line no-await-in-loop
        await round();
        if (ctrl.signal.aborted) {
          setPhase('idle');
          return;
        }
      } while (itemsRef.current.some((it) => it.status === 'pending'));
      await finalize();
    } catch (err) {
      setFatalError(err instanceof Error ? err.message : String(err));
      setPhase('idle');
    }
  }, [phase, token, batchId, patch, photographerName, finalize, t]);

  // Auto-start: the moment files are dropped/picked while idle, upload begins —
  // no button click. Armed only by addFiles, so Cancel and errors don't loop.
  useEffect(() => {
    if (!armedRef.current || phase !== 'idle') return;
    if (!items.some((it) => it.status === 'pending')) return;
    armedRef.current = false;
    void runUploads();
  }, [items, phase, runUploads]);

  const cancel = useCallback(() => {
    armedRef.current = false;
    abortRef.current?.abort();
  }, []);

  const pct = totalBytes > 0 ? Math.round((sentBytes / totalBytes) * 100) : 0;

  return (
    <div className="card" style={{ maxWidth: 640, margin: '0 auto', padding: 20 }}>
      <h2>{t.heading}</h2>

      {phase === 'uploading' && (
        <div
          role="status"
          style={{ background: '#e8f5e9', border: '1px solid #a5d6a7', borderRadius: 8, padding: 12, margin: '12px 0' }}
        >
          <strong>{t.uploadingTitle}</strong> {t.uploadingBody}
          {eta && <div style={{ marginTop: 4, color: '#555' }}>{eta}</div>}
        </div>
      )}

      {phase === 'finalizing' && (
        <div
          role="status"
          style={{ background: '#e8f5e9', border: '1px solid #a5d6a7', borderRadius: 8, padding: 12, margin: '12px 0' }}
        >
          <strong>{t.finalizingTitle}</strong> {t.finalizingBody}
        </div>
      )}

      {phase !== 'done' && (
        <div style={{ margin: '12px 0' }}>
          <label htmlFor="photographer-name" style={{ display: 'block', fontWeight: 600, marginBottom: 4 }}>
            {t.nameLabel} <span className="muted" style={{ fontWeight: 400 }}>{t.nameHint}</span>
          </label>
          <input
            id="photographer-name"
            type="text"
            value={photographerName}
            onChange={(e) => setPhotographerName(e.target.value)}
            placeholder={t.namePlaceholder}
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
            // Ignore drops during finalize — the upload loop has exited and the
            // file would be orphaned. Uploading is fine: a running round picks
            // it up; idle arms the auto-start effect.
            if (phase === 'finalizing') return;
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
            {IS_TOUCH ? t.dropzoneTitleTouch : t.dropzoneTitleDesktop}
          </div>
          <div className="muted">
            {IS_TOUCH ? t.dropzoneHintTouch : t.dropzoneHintDesktop}
          </div>
          <div className="muted">
            {t.filesSelected(items.length)}
          </div>
          <input
            type="file"
            multiple
            accept="image/*,video/mp4,video/quicktime"
            style={{ display: 'none' }}
            onChange={(e) => addFiles(e.target.files)}
            disabled={phase === 'finalizing'}
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
                  {it.resumedFrom ? <span className="muted"> {t.resumed}</span> : null}
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
          <strong>{t.uploadReceived}</strong>
          <p style={{ margin: '4px 0 0' }}>{receipt}</p>
          <p style={{ margin: '8px 0 0', color: '#555' }}>
            {serverPhase === 'received'
              ? t.statusReceived
              : serverPhase === 'saving'
                ? t.statusSaving
                : serverPhase === 'error'
                  ? t.statusError
                  : t.statusDone}
          </p>
          {skipped.length > 0 && (
            <details style={{ marginTop: 10 }}>
              <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
                {t.skippedSummary(skipped.length)}
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
          {phase === 'uploading' && (
            <button className="btn btn-light" onClick={cancel}>
              {t.cancel}
            </button>
          )}
          {phase === 'idle' && fatalError && (
            <button className="btn btn-primary" onClick={() => void runUploads()}>
              {t.retry}
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
