/**
 * Template contract: every authenticated page template MUST inject
 * `window.SESSION_TOKEN` from the server-side `sessionToken` variable.
 *
 * Why this matters:
 *   The client-side session plumbing in src/ui/js/app.html reads
 *   `window.SESSION_TOKEN` as the source of truth for the current user's
 *   session. Navigation (`navigate()`) and google.script.run wrappers both
 *   pull from it. If a new authenticated template forgets this <script>
 *   snippet, the page will either (a) fall back to a stale token from
 *   sessionStorage, hijacking the user to the login page on the next click
 *   ("Session expired or invalid"), or (b) send no token at all and the
 *   server will reject the request.
 *
 *   This kind of bug is silent — the template renders fine, the user sees
 *   the page, and everything breaks only on the NEXT navigation. So we
 *   enforce the invariant at test time.
 *
 * How this test works:
 *   1. Walks src/ui/templates/ recursively, collecting every .html file.
 *   2. Subtracts the small, hardcoded set of UNAUTHENTICATED templates
 *      (login, access_denied, not_found, error).
 *   3. For each remaining template, asserts the canonical injection regex
 *      appears somewhere in the file.
 *
 * Adding a new template:
 *   - Authenticated page → paste the canonical <script> snippet (below) into
 *     the template. This test auto-discovers it; no test change needed.
 *   - Intentionally public page → add its basename to UNAUTHENTICATED_TEMPLATES
 *     with a comment explaining why it's public.
 *
 * The canonical injection snippet (paste this in the template <head>):
 *
 *   <script>
 *     window.SESSION_TOKEN = '<?= (typeof sessionToken !== "undefined" && sessionToken) ? sessionToken : "" ?>';
 *   </script>
 */

import * as fs from 'fs';
import * as path from 'path';

// ── Config ────────────────────────────────────────────────────────────────────

const TEMPLATES_DIR = path.resolve(__dirname, '..', '..', 'src', 'ui', 'templates');

/**
 * Pages that legitimately render for UNAUTHENTICATED users and therefore
 * should NOT inject window.SESSION_TOKEN. Keep this list minimal; the default
 * for any new template is "authenticated".
 *
 * Use the path relative to TEMPLATES_DIR, using forward slashes.
 */
const UNAUTHENTICATED_TEMPLATES: ReadonlySet<string> = new Set([
  'login.html',          // sign-in page itself
  'access_denied.html',  // rendered after auth succeeds but role check fails
  'not_found.html',      // 404 — may render pre-auth if URL is malformed
  'error.html',          // 500 — rendered from catch blocks, sometimes pre-auth

  // Volunteer upload flow — all three pages are intentionally unauthenticated
  // (volunteers are not admin users; they authenticate via a per-session vsession
  // token embedded in the page URL, not via the admin SESSION_TOKEN mechanism).
  'volunteer/confirm.html',    // Step 1: pre-OAuth confirmation page shown to link bearer
  'volunteer/upload.html',     // Step 3: post-OAuth upload interface (uses vsession, not sessionToken)
  'volunteer/link_error.html', // Error page shown when link is revoked or invalid

  // Upload Prep sidebar — opened via a spreadsheet menu (onOpen trigger).
  // Runs under USER_ACCESSING so google.script.run calls are automatically
  // authenticated as the current Google user; no SESSION_TOKEN mechanism needed.
  // Server-side assertSuperAdmin() enforces access independently.
  'uploadPrepSidebar.html',
]);

/**
 * Canonical injection pattern. Matches:
 *   window.SESSION_TOKEN = '<?= (typeof sessionToken !== "undefined" && sessionToken) ? sessionToken : "" ?>';
 *
 * We deliberately require the scriptlet references `sessionToken` (not some
 * other variable) so a copy-paste that forgot to wire up the server var
 * still fails the test.
 *
 * `.*?` is lazy so it won't swallow the closing `?>` even though the
 * canonical snippet contains a ternary `? sessionToken : ""` inside. The
 * whole injection is on one line in every template today, so no /s flag
 * is needed.
 */
const SESSION_TOKEN_INJECTION = /window\.SESSION_TOKEN\s*=\s*['"]<\?=.*?sessionToken.*?\?>['"]/;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Recursively collect all .html files under `dir`, returning paths
 *  relative to `dir` with forward slashes. */
function listHtmlFiles(dir: string, rel = ''): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relChild = rel ? `${rel}/${entry.name}` : entry.name;
    const absChild = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listHtmlFiles(absChild, relChild));
    } else if (entry.isFile() && entry.name.endsWith('.html')) {
      out.push(relChild);
    }
  }
  return out;
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('page templates — window.SESSION_TOKEN injection', () => {
  const allTemplates = listHtmlFiles(TEMPLATES_DIR);
  const authenticated = allTemplates.filter(
    (rel) => !UNAUTHENTICATED_TEMPLATES.has(rel)
  );
  const unauthenticated = allTemplates.filter(
    (rel) => UNAUTHENTICATED_TEMPLATES.has(rel)
  );

  // Sanity: we actually found templates. If this fails, the test is probably
  // looking at the wrong directory (e.g. path refactor).
  it('discovers templates under src/ui/templates/', () => {
    expect(allTemplates.length).toBeGreaterThan(0);
  });

  // Sanity: every denylist entry corresponds to a real file. If a template
  // gets renamed or deleted, fail loudly rather than silently dropping
  // coverage for it.
  describe('UNAUTHENTICATED_TEMPLATES denylist hygiene', () => {
    it.each(Array.from(UNAUTHENTICATED_TEMPLATES))(
      '%s exists on disk',
      (rel) => {
        const full = path.join(TEMPLATES_DIR, rel);
        expect(fs.existsSync(full)).toBe(true);
      }
    );

    it('every denylisted template was actually found by discovery', () => {
      const missing = Array.from(UNAUTHENTICATED_TEMPLATES).filter(
        (rel) => !allTemplates.includes(rel)
      );
      expect(missing).toEqual([]);
    });
  });

  // The main contract. Parametrized so Jest reports WHICH template failed.
  describe('every authenticated template injects window.SESSION_TOKEN', () => {
    if (authenticated.length === 0) {
      // Guard against a bug in this test file itself that would otherwise
      // make the suite vacuously pass.
      it('authenticated list is non-empty', () => {
        expect(authenticated.length).toBeGreaterThan(0);
      });
      return;
    }

    it.each(authenticated)('%s', (rel) => {
      const full = path.join(TEMPLATES_DIR, rel);
      const src = fs.readFileSync(full, 'utf-8');
      if (!SESSION_TOKEN_INJECTION.test(src)) {
        // Fail with an actionable message so new contributors know what
        // to add without hunting for documentation.
        throw new Error(
          `Template "${rel}" is missing the window.SESSION_TOKEN injection.\n` +
          `Add this <script> block inside <head> (before app.html is included):\n\n` +
          `  <script>\n` +
          `    window.SESSION_TOKEN = '<?= (typeof sessionToken !== "undefined" && sessionToken) ? sessionToken : "" ?>';\n` +
          `  </script>\n\n` +
          `If this template is intentionally public (no session required), ` +
          `add "${rel}" to UNAUTHENTICATED_TEMPLATES in ${path.basename(__filename)}.`
        );
      }
    });
  });

  // Negative contract: unauthenticated templates MUST NOT inject the token.
  // This catches the reverse mistake — a public page that leaked the admin's
  // session into window scope. Less likely but cheap to check.
  describe('unauthenticated templates do NOT inject window.SESSION_TOKEN', () => {
    if (unauthenticated.length === 0) return;

    it.each(unauthenticated)('%s', (rel) => {
      const full = path.join(TEMPLATES_DIR, rel);
      const src = fs.readFileSync(full, 'utf-8');
      expect(src).not.toMatch(SESSION_TOKEN_INJECTION);
    });
  });
});
