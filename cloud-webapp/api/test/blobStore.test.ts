/**
 * blobStore.test.ts — the Azure Blob adapter against the SAME contract as the
 * shared fake, plus the behaviours that are Azure-specific.
 *
 * The store runs over `helpers/fakeBlobService.ts`, which models the service in
 * Azure's own vocabulary. That covers the normalization and the SAS policy; it
 * cannot cover real SAS validation, account-level CORS, transaction cost, or
 * whether a browser's Put Block List behaves as documented — those need Azurite
 * or a live account and stay an AZ4 gate.
 */

import { describe, it, expect } from 'vitest';

import { BlobStore, sdkOps, type BlobOps, type SasSigner } from '../src/lib/storage/blobStore.js';
import { FakeBlobService, blobHarness } from './helpers/fakeBlobService.js';
import { runObjectStoreContract } from './helpers/objectStoreContract.js';

runObjectStoreContract('BlobStore', blobHarness);

/**
 * A `BlobOps` that delegates to `svc` but records the `download` range it was
 * asked for. Explicit delegation rather than an object spread: `FakeBlobService`
 * is a class, so its methods live on the prototype and a spread would drop them.
 */
function downloadSpy(svc: FakeBlobService): { ops: BlobOps; ranges: Array<{ offset: number; count: number } | undefined> } {
  const ranges: Array<{ offset: number; count: number } | undefined> = [];
  const ops: BlobOps = {
    getProperties: (c, k) => svc.getProperties(c, k),
    upload: (c, k, b, o) => svc.upload(c, k, b, o),
    deleteIfExists: (c, k) => svc.deleteIfExists(c, k),
    list: (c, p, l) => svc.list(c, p, l),
    sasUrl: (c, k, o) => svc.sasUrl(c, k, o),
    download: (c, k, range) => {
      ranges.push(range);
      return svc.download(c, k, range);
    },
  };
  return { ops, ranges };
}

describe('Blob adapter — md5 normalization', () => {
  it('converts the service\'s md5 BYTES to lowercase hex', async () => {
    const svc = new FakeBlobService();
    const store = new BlobStore(svc);
    svc.seed('c', 'a.jpg', { body: 'hello' });
    expect((await store.head('c', 'a.jpg'))?.md5Hex).toBe('5d41402abc4b2a76b9719d911017c592');
  });

  it('reports NO hash for a blob a browser committed', async () => {
    // Azure stores only the Content-MD5 the writer supplied, and the block-blob
    // commit path does not supply one. This is the normal case for every
    // volunteer upload on Azure, not an edge case — which is why '' has to mean
    // "unknown" everywhere downstream and never "not a duplicate".
    const svc = new FakeBlobService();
    const store = new BlobStore(svc);
    svc.seed('c', 'a.jpg', { body: 'hello', md5Hex: '' });
    expect((await store.head('c', 'a.jpg'))?.md5Hex).toBe('');
  });

  it('rejects a hash that is not 16 bytes rather than passing on short hex', async () => {
    const svc = new FakeBlobService();
    const store = new BlobStore(svc);
    svc.seed('c', 'a.jpg', { body: 'hello' });
    // Corrupt the stored hash to a truncated one, as a proxy for a service that
    // hands back something unexpected.
    const blob = svc.containers.get('c')?.get('a.jpg');
    if (blob) blob.contentMD5 = new Uint8Array([1, 2, 3]);
    expect((await store.head('c', 'a.jpg'))?.md5Hex).toBe('');
  });
});

describe('Blob adapter — ranges', () => {
  it('translates an INCLUSIVE range into offset + count', async () => {
    // HTTP/GCS `{ start: 4, end: 9 }` is 6 bytes, not 5. The chunked video copy
    // depends on this being exact, chunk after chunk.
    const svc = new FakeBlobService();
    svc.seed('c', 'a.mp4', { body: 'abcdefghij' });
    const { ops, ranges } = downloadSpy(svc);
    const store = new BlobStore(ops);
    expect((await store.read('c', 'a.mp4', { start: 4, end: 9 })).toString()).toBe('efghij');
    expect(ranges).toEqual([{ offset: 4, count: 6 }]);
  });

  it('passes no range at all when the caller wants the whole object', async () => {
    const svc = new FakeBlobService();
    svc.seed('c', 'a.jpg', { body: 'abc' });
    const { ops, ranges } = downloadSpy(svc);
    await new BlobStore(ops).read('c', 'a.jpg');
    expect(ranges).toEqual([undefined]);
  });
});

describe('Blob adapter — SAS policy', () => {
  it('asks for read-only permission on a display URL', async () => {
    const svc = new FakeBlobService();
    const store = new BlobStore(svc);
    await store.signReadUrl('c', 'e1/photos/thumb/p1.jpg', { ttlMs: 60_000 });
    expect(svc.sas.at(-1)).toMatchObject({ permissions: 'r', ttlMs: 60_000 });
  });

  it('carries the Content-Disposition into the SAS, not into the app response', async () => {
    // The whole point of signing with `rscd` is that the bytes never pass
    // through the api — a Save-As name has to ride on the storage URL.
    const svc = new FakeBlobService();
    const store = new BlobStore(svc);
    await store.signReadUrl('c', 'e1/photos/orig/p1.jpg', { ttlMs: 60_000, filename: '湘舍动.jpg' });
    expect(svc.sas.at(-1)?.contentDisposition).toBe(
      "attachment; filename*=UTF-8''%E6%B9%98%E8%88%8D%E5%8A%A8.jpg",
    );
  });

  it('omits the disposition entirely when there is no filename', async () => {
    const svc = new FakeBlobService();
    const store = new BlobStore(svc);
    await store.signReadUrl('c', 'e1/photos/web/p1.jpg', { ttlMs: 60_000 });
    expect(svc.sas.at(-1)?.contentDisposition).toBeUndefined();
  });

  it('grants an upload session READ as well as create+write', async () => {
    // Read is what lets a resumed upload list its own uncommitted blocks. Drop
    // it and a dropped connection restarts the whole file — on a phone, at an
    // event, that is the failure the resumable path exists to prevent.
    const svc = new FakeBlobService();
    const store = new BlobStore(svc);
    const session = await store.createUploadSession('staging', 'vol/e1/b1/u1.jpg', {
      contentType: 'image/jpeg',
      metadata: { eventId: 'e1' },
      ttlMs: 7 * 24 * 3600_000,
    });
    expect(svc.sas.at(-1)?.permissions).toBe('rcw');
    expect(session.protocol).toBe('azure-block-blob');
    // Put Block List overwrites metadata, so the server cannot pin it.
    expect(session.clientStampsMetadata).toBe(true);
  });
});

describe('Blob adapter — sdkOps', () => {
  /**
   * Minimal stand-in for the bits of the SDK `sdkOps` reaches into. Cast once,
   * here, so no call site needs an `any`.
   */
  function fakeSdk(overrides: Record<string, unknown> = {}): Parameters<typeof sdkOps>[0] {
    const props = { contentLength: 3, contentType: 'image/jpeg' };
    const blob = {
      url: 'https://acct.blob.core.windows.net/c/a.jpg',
      getProperties: async () => props,
      downloadToBuffer: async () => Buffer.from('abc'),
      upload: async () => undefined,
      deleteIfExists: async () => undefined,
      ...overrides,
    };
    return {
      accountName: 'acct',
      getUserDelegationKey: async () => ({}),
      getContainerClient: () => ({
        getBlockBlobClient: () => blob,
        listBlobsFlat: () =>
          (async function* () {
            yield { name: 'e1/a.jpg', properties: props, metadata: { linkId: 'l1' } };
            yield { name: 'e1/b.jpg', properties: props, metadata: {} };
          })(),
      }),
    } as unknown as Parameters<typeof sdkOps>[0];
  }

  const signer: SasSigner = { sign: async () => 'sig=abc&se=later' };

  it('maps a 404 from getProperties to null', async () => {
    const ops = sdkOps(
      fakeSdk({
        getProperties: async () => {
          throw Object.assign(new Error('BlobNotFound'), { statusCode: 404 });
        },
      }),
      signer,
    );
    expect(await ops.getProperties('c', 'a.jpg')).toBeNull();
  });

  it('lets a non-404 error propagate', async () => {
    const ops = sdkOps(
      fakeSdk({
        getProperties: async () => {
          throw Object.assign(new Error('AuthorizationFailure'), { statusCode: 403 });
        },
      }),
      signer,
    );
    await expect(ops.getProperties('c', 'a.jpg')).rejects.toThrow(/AuthorizationFailure/);
  });

  it('folds a list item\'s metadata in beside its properties', async () => {
    // On a list item `metadata` sits NEXT TO `properties`, unlike getProperties()
    // where everything is one object. Miss it and every staged object looks
    // uncredited — which is how photographer credit would silently vanish.
    const ops = sdkOps(fakeSdk(), signer);
    const out = await ops.list('c', 'e1/');
    expect(out[0]?.props.metadata).toEqual({ linkId: 'l1' });
  });

  it('stops listing at the limit instead of draining every page', async () => {
    const ops = sdkOps(fakeSdk(), signer);
    expect(await ops.list('c', 'e1/', 1)).toHaveLength(1);
  });

  it('appends the signature to the blob URL', async () => {
    const ops = sdkOps(fakeSdk(), signer);
    expect(await ops.sasUrl('c', 'a.jpg', { permissions: 'r', ttlMs: 1000 })).toBe(
      'https://acct.blob.core.windows.net/c/a.jpg?sig=abc&se=later',
    );
  });

  it('back-dates the SAS start to absorb clock skew', async () => {
    const seen: Array<{ startsOn: Date; expiresOn: Date }> = [];
    const ops = sdkOps(fakeSdk(), {
        sign: async (args) => {
          seen.push({ startsOn: args.startsOn, expiresOn: args.expiresOn });
        return 'sig=abc';
      },
    });
    const before = Date.now();
    await ops.sasUrl('c', 'a.jpg', { permissions: 'r', ttlMs: 60_000 });
    const call = seen[0];
    expect(call).toBeDefined();
    // A SAS whose validity starts "now" is rejected by a client whose clock is a
    // few seconds behind the service.
    expect(call!.startsOn.getTime()).toBeLessThan(before);
    expect(call!.expiresOn.getTime()).toBeGreaterThanOrEqual(before + 60_000);
  });
});
