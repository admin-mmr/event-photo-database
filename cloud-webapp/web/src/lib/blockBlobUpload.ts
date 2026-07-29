/**
 * blockBlobUpload.ts — browser-side Azure block-blob upload with resume (AZ2).
 *
 * The Azure counterpart of the GCS resumable path in `resumableUpload.ts`, which
 * dispatches to this module when the api reports `protocol: 'azure-block-blob'`.
 * On GCP nothing here runs.
 *
 * The protocols are genuinely different, which is why this is a separate module
 * rather than a flag inside the other one:
 *
 *   GCS    one session URI; PUT each chunk with `Content-Range`; the service
 *          tracks the committed offset and reports it as HTTP 308 + `Range`.
 *   Azure  a SAS URL for the blob; PUT each chunk as a *named block*
 *          (`?comp=block&blockid=<base64>`), which commits nothing; then one
 *          `PUT ?comp=blocklist` with an XML list assembles the blob. Resume
 *          means asking which blocks are already staged
 *          (`GET ?comp=blocklist&blocklisttype=uncommitted`) — the SAS carries
 *          `r` as well as `cw` for exactly that.
 *
 * Two consequences worth knowing before changing anything here:
 *
 *  - **Nothing exists until the block list is committed.** A volunteer who
 *    closes the tab mid-file leaves uncommitted blocks, which Azure garbage
 *    collects after a week — the same window as an unfinalized GCS resumable
 *    upload, and the same window `uploadDb` expires its records on. It also
 *    means upload-recovery can only ever see files whose commit succeeded.
 *  - **The commit carries the metadata.** "When you call Put Block List to
 *    update an existing blob, the blob's existing properties and metadata are
 *    overwritten", so the api cannot pin metadata onto the blob in advance; it
 *    sends what to stamp and this module sends it. Server-side, none of it is
 *    trusted for authorization — see `CreateUploadSessionResponse.metadata`.
 */

/** Block ids must be equal-length and base64. 5 digits covers 50,000 blocks,
 *  which is Azure's per-blob ceiling. */
export function blockId(index: number): string {
  return btoa(String(index).padStart(5, '0'));
}

/** Byte offset a 0-based block index starts at. */
export function blockOffset(index: number, chunkSize: number): number {
  return index * chunkSize;
}

/** `url` with extra query parameters appended, preserving the SAS token. */
export function withQuery(url: string, params: Record<string, string>): string {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

/**
 * Parse a `Get Block List` response into the set of block ids already staged.
 *
 * Deliberately a regex over the XML rather than DOMParser: the response is a
 * flat `<Block><Name>…</Name><Size>…</Size></Block>` list, and a parser here
 * would be the only XML dependency in the bundle.
 */
export function parseUncommittedBlockIds(xml: string): Set<string> {
  const ids = new Set<string>();
  for (const m of xml.matchAll(/<Name>([^<]*)<\/Name>/g)) {
    if (m[1]) ids.add(m[1]);
  }
  return ids;
}

/** The XML body of a `Put Block List` for `count` blocks, in order. */
export function buildBlockListXml(count: number): string {
  const latest = Array.from({ length: count }, (_, i) => `<Latest>${blockId(i)}</Latest>`).join('');
  return `<?xml version="1.0" encoding="utf-8"?><BlockList>${latest}</BlockList>`;
}

/**
 * Which blocks still need uploading, given the ids the service says it holds.
 *
 * A staged block is trusted only when the service reports it, so a chunk whose
 * PUT was cut off mid-flight is simply re-sent — Put Block is idempotent per id.
 */
export function missingBlocks(total: number, chunkSize: number, staged: Set<string>): number[] {
  const count = Math.max(1, Math.ceil(total / chunkSize));
  const out: number[] = [];
  for (let i = 0; i < count; i += 1) {
    if (!staged.has(blockId(i))) out.push(i);
  }
  return out;
}

/** Bytes already staged, for the progress bar on a resumed upload. */
export function stagedBytes(total: number, chunkSize: number, staged: Set<string>): number {
  const count = Math.max(1, Math.ceil(total / chunkSize));
  let bytes = 0;
  for (let i = 0; i < count; i += 1) {
    if (staged.has(blockId(i))) {
      bytes += Math.min(chunkSize, total - blockOffset(i, chunkSize));
    }
  }
  return bytes;
}

export interface BlockBlobCallbacks {
  /** Bytes committed so far for THIS file (0..total). */
  onProgress?: (bytesSent: number) => void;
  /** Fired once when a partial upload is picked back up. */
  onResumed?: (fromByte: number) => void;
  signal?: AbortSignal;
}

class AbortError extends Error {
  constructor() {
    super('Upload aborted');
    this.name = 'AbortError';
  }
}

/** Blocks the service already holds for this blob. Empty on a fresh upload. */
export async function queryStagedBlocks(sasUrl: string): Promise<Set<string>> {
  const res = await fetch(withQuery(sasUrl, { comp: 'blocklist', blocklisttype: 'uncommitted' }));
  // 404 = the blob has no staged blocks at all, which is the normal fresh case.
  if (res.status === 404) return new Set();
  if (!res.ok) throw new Error(`Block list query failed: HTTP ${res.status}`);
  return parseUncommittedBlockIds(await res.text());
}

/** PUT one block via XHR (for upload progress). */
function putBlock(
  sasUrl: string,
  file: File,
  index: number,
  chunkSize: number,
  onProgress: (sentInThisBlock: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AbortError());
    const start = blockOffset(index, chunkSize);
    const blob = file.slice(start, Math.min(start + chunkSize, file.size));

    const xhr = new XMLHttpRequest();
    xhr.open('PUT', withQuery(sasUrl, { comp: 'block', blockid: blockId(index) }));
    xhr.setRequestHeader('x-ms-blob-type', 'BlockBlob');

    const onAbort = (): void => xhr.abort();
    signal?.addEventListener('abort', onAbort);
    const cleanup = (): void => signal?.removeEventListener('abort', onAbort);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded);
    };
    xhr.onload = () => {
      cleanup();
      // Put Block answers 201 Created.
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`Block PUT failed: HTTP ${xhr.status}`));
    };
    xhr.onerror = () => {
      cleanup();
      reject(new Error('Network error during block upload'));
    };
    xhr.onabort = () => {
      cleanup();
      reject(new AbortError());
    };
    xhr.send(blob);
  });
}

/**
 * Commit the staged blocks into the blob, stamping content type + metadata.
 *
 * This is the only request that makes the object exist, and the only chance to
 * set its metadata — Put Block List overwrites whatever was there.
 */
export async function commitBlockList(
  sasUrl: string,
  blockCount: number,
  contentType: string,
  metadata: Record<string, string>,
): Promise<void> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/xml',
    'x-ms-blob-content-type': contentType || 'application/octet-stream',
  };
  for (const [k, v] of Object.entries(metadata)) {
    // Metadata names have to be valid C# identifiers; ours are camelCase keys
    // chosen by the api, so nothing needs escaping — but skip a blank value
    // rather than sending an empty header the service would reject.
    if (v !== '') headers[`x-ms-meta-${k}`] = v;
  }
  const res = await fetch(withQuery(sasUrl, { comp: 'blocklist' }), {
    method: 'PUT',
    headers,
    body: buildBlockListXml(blockCount),
  });
  if (!res.ok) throw new Error(`Block list commit failed: HTTP ${res.status}`);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Upload one file as a block blob, resuming whatever is already staged.
 *
 * `backoffMs` and `maxRetries` come from the caller so both protocols retry on
 * the same schedule.
 */
export async function uploadBlockBlob(
  sasUrl: string,
  file: File,
  opts: {
    chunkSize: number;
    contentType: string;
    metadata: Record<string, string>;
    maxRetries: number;
    backoffMs: (attempt: number) => number;
  },
  cb: BlockBlobCallbacks = {},
): Promise<void> {
  const { chunkSize, maxRetries, backoffMs } = opts;
  const staged = await queryStagedBlocks(sasUrl);
  const blockCount = Math.max(1, Math.ceil(file.size / chunkSize));

  let committed = stagedBytes(file.size, chunkSize, staged);
  if (committed > 0) cb.onResumed?.(committed);
  cb.onProgress?.(committed);

  for (const index of missingBlocks(file.size, chunkSize, staged)) {
    let attempt = 0;
    for (;;) {
      if (cb.signal?.aborted) throw new AbortError();
      try {
        await putBlock(
          sasUrl,
          file,
          index,
          chunkSize,
          (sentInThisBlock) => cb.onProgress?.(committed + sentInThisBlock),
          cb.signal,
        );
        committed += Math.min(chunkSize, file.size - blockOffset(index, chunkSize));
        cb.onProgress?.(committed);
        break;
      } catch (err) {
        if (err instanceof AbortError) throw err;
        if (++attempt > maxRetries) throw err;
        await sleep(backoffMs(attempt));
      }
    }
  }

  // Only now does the blob exist.
  await commitBlockList(sasUrl, blockCount, opts.contentType, opts.metadata);
  cb.onProgress?.(file.size);
}

export { AbortError };
