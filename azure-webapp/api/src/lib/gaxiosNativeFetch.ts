/**
 * gaxiosNativeFetch.ts — force gaxios onto Node's native fetch (undici).
 *
 * gaxios 6.x is the HTTP client buried inside BOTH `google-auth-library` and
 * `@google-cloud/storage`. In Node it hardcodes `node-fetch@2` (it only uses a
 * native fetch when a browser `window.fetch` exists — see gaxios `gaxios.js`:
 * `const fetch = hasFetch() ? window.fetch : node_fetch.default`). `node-fetch@2`
 * throws a spurious "Premature close" on Node 18+ whenever an upstream
 * (iamcredentials, run.googleapis.com, …) closes the connection after the
 * response — which 500'd `/api/admin/sync` (signJwt), `/api/events/:id/index`
 * (Jobs API), and the gallery's V4 signed-URL signing (signBlob).
 *
 * gaxios honors a per-request `fetchImplementation`, so we patch the shared
 * `Gaxios.prototype.request` once to inject `globalThis.fetch` (undici) into
 * every request that doesn't already specify one. This fixes every gaxios call
 * site — including the ones inside @google-cloud/storage that we can't reach
 * directly — without a risky dependency-tree upgrade.
 *
 * Import this module FOR ITS SIDE EFFECT before anything uses google-auth-library
 * or @google-cloud/storage (i.e. the first import in index.ts).
 */
import { Gaxios, type GaxiosOptions } from 'gaxios';

const originalRequest = Gaxios.prototype.request;

Gaxios.prototype.request = function patchedRequest(this: Gaxios, opts: GaxiosOptions = {}) {
  if (opts.fetchImplementation == null) {
    opts.fetchImplementation = globalThis.fetch as unknown as NonNullable<
      GaxiosOptions['fetchImplementation']
    >;
  }
  return originalRequest.call(this, opts);
} as typeof Gaxios.prototype.request;
