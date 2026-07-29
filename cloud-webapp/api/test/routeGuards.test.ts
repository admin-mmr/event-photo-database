/**
 * routeGuards.test.ts — the authorization spec, asserted against the LIVE route
 * table (AZ2 rules-spec port).
 *
 * ## Why this file exists
 *
 * `infra/firestore.rules` and `infra/storage.rules` are both **deny-all**: no
 * browser has ever been allowed to touch Firestore or GCS directly, and every
 * authorization decision in this app is made by api middleware. That is
 * fortunate for the Azure port — Cosmos and Blob Storage have no client-side
 * rules engine to replace — but it also means the *entire* access model is these
 * guards. On GCP a mistake here is still backstopped by the deny-all rules; on
 * Azure there is no backstop at all.
 *
 * So the spec is written down as executable assertions rather than prose:
 *
 *   1. Every route authenticates somehow. A new route with no guard fails here.
 *   2. Every `/admin/**` route requires an admin role or a machine token — a
 *      signed-in member must not reach the control plane.
 *   3. The five routes with no authenticating middleware are listed explicitly
 *      — four check a credential inside the handler, one (`/health`) is public
 *      by design. Nothing may join that list silently, and an entry that stops
 *      being needed must be removed.
 *
 * Route introspection is by middleware function *name* (which is why
 * `requireRole`/`requireClubScope` return named functions) and, where two guards
 * share a name, by function *identity*.
 *
 * See `azure-webapp/infra/cosmos-access-notes.md` and `blob-access-notes.md` for
 * the same model stated for the Azure side.
 */

import { describe, it, expect } from 'vitest';

process.env.NODE_ENV = 'test';

const { buildServer } = await import('../src/server.js');
const { requireAnyAdmin, requireSuperAdmin } = await import('../src/middleware/rbac.js');

// ── route-table introspection ────────────────────────────────────────────────

interface RouteInfo {
  method: string;
  path: string;
  guards: string[];
  /**
   * The middleware functions themselves.
   *
   * `requireAnyAdmin` and `requireSuperAdmin` are both `requireRole(...)`
   * results, so they share the name `requireRoleGuard` — only identity tells
   * them apart, and "is this route super_admin-only?" is exactly the question
   * that needs telling apart.
   */
  handles: unknown[];
}

/**
 * The path a Router was mounted at, recovered from its Express layer regexp
 * (`^\/api\/?(?=\/|$)` → `/api`). Returns `''` for a layer mounted at `/`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mountPath(layer: any): string {
  if (layer.regexp?.fast_slash) return '';
  const source = String(layer.regexp?.source ?? '');
  return source
    .replace('\\/?(?=\\/|$)', '')
    .replace(/^\^/, '')
    .replace(/\$$/, '')
    .replace(/\\\//g, '/');
}

/**
 * Every route Express has registered, with the names of its middleware.
 *
 * Reaches into `app._router` deliberately: the alternative is a hand-kept list
 * of routes, which is exactly the thing that goes stale and lets an unguarded
 * route through. Express 4's shape is stable and pinned in package.json — and if
 * it does change, the assertions below fail loudly rather than passing on an
 * empty table.
 */
function routeTable(app: ReturnType<typeof buildServer>): RouteInfo[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stack = (app as any)._router?.stack as any[] | undefined;
  expect(stack, 'express router stack — shape changed?').toBeTruthy();

  const out: RouteInfo[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const visit = (layers: any[], prefix: string): void => {
    for (const layer of layers) {
      if (layer.route) {
        const path = prefix + layer.route.path;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const guards = (layer.route.stack as any[]).map((s) => String(s.name || '<anonymous>'));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const handles = (layer.route.stack as any[]).map((s) => s.handle);
        for (const method of Object.keys(layer.route.methods)) {
          out.push({ method: method.toUpperCase(), path, guards, handles });
        }
      } else if (layer.handle?.stack) {
        visit(layer.handle.stack, prefix + mountPath(layer));
      }
    }
  };
  visit(stack!, '');
  return out;
}

/** Middleware that establishes WHO the caller is. */
const AUTHENTICATORS = new Set([
  'requireAuth', // Firebase ID token → a signed-in member
  'allowCronOrAdmin', // X-Sync-Token (machine) OR an admin session
  'allowCronOrSuperAdmin', // X-Sync-Token (machine) OR a super_admin session
  'requirePartner', // partner API key
]);

/** Middleware that establishes the caller may act on the CONTROL PLANE. */
const ADMIN_GUARDS = new Set(['requireRoleGuard', 'allowCronOrAdmin', 'allowCronOrSuperAdmin']);

/**
 * Routes that are deliberately reachable without a Firebase session, each with
 * the credential it checks *inside* the handler.
 *
 * These are the ones a reader grepping for middleware would misread as
 * unprotected, so they are enumerated rather than pattern-matched. Adding an
 * entry here should take a conversation.
 */
const HANDLER_GATED: Record<string, string> = {
  'GET /api/health':
    'public by design — liveness probe, returns no data about the org',
  'POST /api/volunteer/upload/session':
    'upload-link token in the body → validateUploadLink(); plus a per-token rate limit and reCAPTCHA',
  'POST /api/volunteer/upload/complete':
    'upload-link token in the body → validateUploadLink()',
  'GET /api/volunteer/upload/status/:batchId':
    'upload-link token in the query → validateUploadLink(), AND the batch must belong to that link’s event',
  'POST /api/internal/process-batch':
    'X-Sync-Token → validCronToken(); the Cloud Tasks worker, never called by a browser',
};

const app = buildServer();
const routes = routeTable(app);
const key = (r: RouteInfo): string => `${r.method} ${r.path}`;

describe('route table', () => {
  it('is non-trivial, so a broken introspection cannot vacuously pass', () => {
    // Every assertion below iterates the table; an empty table would make them
    // all succeed while checking nothing.
    expect(routes.length).toBeGreaterThan(60);
  });

  it('registers every route under /api', () => {
    // The Firebase Hosting rewrite only forwards /api/**. A route outside it is
    // unreachable in production, which is a silent 404 rather than an error.
    for (const r of routes) expect(r.path.startsWith('/api'), key(r)).toBe(true);
  });
});

describe('every route authenticates', () => {
  it('has an authenticating middleware, or is a documented handler-gated route', () => {
    const unguarded = routes
      .filter((r) => !r.guards.some((g) => AUTHENTICATORS.has(g)))
      .filter((r) => !(key(r) in HANDLER_GATED))
      .map(key);
    // If this fails, either add the guard or — if the route really does
    // authenticate itself — add it to HANDLER_GATED with the credential it checks.
    expect(unguarded).toEqual([]);
  });

  it('does not list a route as handler-gated once it has real middleware', () => {
    // Keeps the allowlist honest: an entry that stops being necessary must go,
    // or it becomes a standing exemption nobody re-examines.
    const redundant = Object.keys(HANDLER_GATED).filter((k) => {
      const r = routes.find((x) => key(x) === k);
      return r !== undefined && r.guards.some((g) => AUTHENTICATORS.has(g));
    });
    expect(redundant).toEqual([]);
  });

  it('does not list a route that no longer exists', () => {
    const stale = Object.keys(HANDLER_GATED).filter((k) => !routes.some((r) => key(r) === k));
    expect(stale).toEqual([]);
  });
});

describe('the control plane is admin-only', () => {
  it('guards every /api/admin/** route with a role check or a machine token', () => {
    // The Sheet is the SSOT and has no row-level security, so this middleware is
    // the ONLY thing standing in front of a control-plane write (rbac.ts).
    const weak = routes
      .filter((r) => r.path.startsWith('/api/admin/'))
      .filter((r) => !r.guards.some((g) => ADMIN_GUARDS.has(g)))
      .map(key);
    expect(weak).toEqual([]);
  });

  it('resolves the role before checking it, on every route that checks one', () => {
    // requireRoleGuard reads req.user.role, which only attachRole populates.
    // Without it the route 403s everyone — fail-closed, so it would not show up
    // as a breach, just as an admin page that mysteriously stopped working.
    const missing = routes
      .filter((r) => r.guards.includes('requireRoleGuard'))
      .filter((r) => !r.guards.includes('attachRole'))
      .map(key);
    expect(missing).toEqual([]);
  });

  it('authenticates before resolving a role, on every route that resolves one', () => {
    // attachRole reads req.user.email; with no requireAuth ahead of it there is
    // no user, so it no-ops and any role check behind it denies everyone.
    const missing = routes
      .filter((r) => r.guards.includes('attachRole'))
      .filter((r) => !r.guards.includes('requireAuth'))
      .map(key);
    expect(missing).toEqual([]);
  });

  it('keeps super_admin-only the routes that are cross-club by nature', () => {
    // Deleting an event touches every club's photos in it, and the audit log and
    // user/club administration are org-wide. A club_admin must not reach these.
    // Named routes, not a pattern: this is a product decision per route.
    //
    // Asserted by function IDENTITY, because requireAnyAdmin and
    // requireSuperAdmin are both requireRole(...) results and so share a name —
    // a name check here would pass on the club_admin-permitting guard, which is
    // the exact mistake worth catching.
    const superAdminOnly = [
      'GET /api/admin/audit',
      'POST /api/admin/users',
      'PATCH /api/admin/users/:email',
      'POST /api/admin/clubs',
      'GET /api/admin/events/:eventId/delete-preview',
      'POST /api/admin/masquerade/start',
      'POST /api/admin/masquerade/end',
    ];
    for (const k of superAdminOnly) {
      const r = routes.find((x) => key(x) === k);
      expect(r, `${k} — route renamed or removed?`).toBeDefined();
      expect(r!.handles, k).toContain(requireSuperAdmin);
      expect(r!.handles, `${k} must not accept a club_admin`).not.toContain(requireAnyAdmin);
    }
  });

  it('is the only place super_admin-only-ness is decided — the two guards differ', () => {
    // Guards against a refactor that aliased one to the other, which would make
    // every assertion above vacuously true.
    expect(requireSuperAdmin).not.toBe(requireAnyAdmin);
  });
});

describe('the deny-all rules have nothing to enforce', () => {
  it('never exposes a data-plane credential to the browser', async () => {
    // firestore.rules / storage.rules deny ALL client access. On Azure there is
    // no rules engine, so what keeps that true is simply that the web bundle
    // holds no database or storage client — it only ever calls /api/**.
    //
    // This is asserted over the web source rather than the api because that is
    // where a regression would land: someone adding `firebase/firestore` to the
    // SPA would silently create direct client access that Azure cannot refuse.
    const { readdir, readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');

    const webSrc = new URL('../../web/src', import.meta.url).pathname;
    const files: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) await walk(p);
        else if (/\.(ts|tsx)$/.test(entry.name)) files.push(p);
      }
    };
    await walk(webSrc);
    expect(files.length, 'web/src not found — path changed?').toBeGreaterThan(20);

    const offenders: string[] = [];
    for (const f of files) {
      const src = await readFile(f, 'utf8');
      if (/from\s+['"]firebase\/(firestore|storage|database)['"]/.test(src)) {
        offenders.push(f.slice(webSrc.length + 1));
      }
    }
    expect(offenders).toEqual([]);
  });
});
