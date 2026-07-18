#!/usr/bin/env node
/**
 * parity-check.mjs — automated Phase B parity harness (CUTOVER_RUNBOOK.md §B).
 *
 * Exercises the deployed cloud-webapp admin API across the Phase B parity matrix
 * and reports PASS / FAIL / SKIP per flow, with the Google Sheet tab each flow
 * writes so you can eyeball the SSOT alongside. The Sheet stays the source of
 * truth; a green run here means cloud-webapp's API round-trips and the record is
 * retrievable — confirm the tab itself for the authoritative diff.
 *
 * Dependency-free: Node 18+ (global fetch). No build step, no npm install.
 *
 * AUTH — you need an admin Firebase ID token. Easiest way to grab one:
 *   1. Sign in to the deployed web app as a super_admin.
 *   2. Open DevTools → Network, click any /api/... request.
 *   3. Copy the value of the `Authorization` header AFTER "Bearer " (just the JWT).
 *   (ID tokens expire ~1h; grab a fresh one right before running.)
 *
 * USAGE
 *   ADMIN_ID_TOKEN=<jwt> node infra/scripts/parity-check.mjs [flags]
 *
 * FLAGS
 *   --base=<url>        API base (default https://mmr-data-pipeline.web.app, or $API_BASE_URL)
 *   --write            run the REVERSIBLE write cycle (create→read back→deactivate/revoke).
 *                      Writes go to the real Sheet — uses clearly-labelled test rows it cleans up.
 *   --event=<eventId>  exercise Upload_Links create/rotate/revoke against this existing event
 *                      (needs --write). Skipped if omitted (no throwaway events are created).
 *   --email            allow POST /admin/email/daily (SENDS real digest mail). Off by default.
 *   --partner-key=<k>  also check the partner API (GET /partner/events). Or $PARTNER_API_KEY.
 *   --json             emit machine-readable JSON instead of the table.
 *   --help
 *
 * EXIT CODE  0 = all non-skipped checks passed; 1 = at least one failed; 2 = setup error.
 */

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (name, env) => {
  const pre = `--${name}=`;
  const a = args.find((x) => x.startsWith(pre));
  return a ? a.slice(pre.length) : (env ? process.env[env] : undefined);
};

if (has('--help')) {
  console.log(await import('node:fs').then((fs) => fs.readFileSync(new URL(import.meta.url)).toString().split('\n').filter((l) => l.startsWith(' *') || l.startsWith('/**')).map((l) => l.replace(/^\/?\*+ ?/, '')).join('\n')));
  process.exit(0);
}

const BASE = (val('base', 'API_BASE_URL') || 'https://mmr-data-pipeline.web.app').replace(/\/$/, '');
const TOKEN = val('token', 'ADMIN_ID_TOKEN') || '';
const PARTNER_KEY = val('partner-key', 'PARTNER_API_KEY') || '';
const DO_WRITE = has('--write');
const DO_EMAIL = has('--email');
const EVENT_ID = val('event') || process.env.TEST_EVENT_ID || '';
const JSON_OUT = has('--json');
const STAMP = Date.now();

if (!TOKEN) {
  console.error('ERROR: set ADMIN_ID_TOKEN (an admin Firebase ID token). See --help.');
  process.exit(2);
}

/** One HTTP call. Returns { status, json, text }. Never throws on HTTP status. */
async function api(method, path, { body, token = TOKEN, headers = {} } = {}) {
  const h = { Accept: 'application/json', ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: h,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
  return { status: res.status, json, text };
}

class Skip extends Error {}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const skip = (msg) => { throw new Skip(msg); };

const checks = [];
const check = (id, sheetTab, fn) => checks.push({ id, sheetTab, fn });

// Shared state populated as checks run.
const ctx = { role: null, clubForLinks: null, createdClubNorm: null };

// ── Read-only smoke + shape + RBAC ──────────────────────────────────────────

check('health', '—', async () => {
  const r = await api('GET', '/api/health', { token: '' });
  assert(r.status === 200 && r.json?.ok === true, `expected 200 ok, got ${r.status}`);
  return `version ${r.json.version}, commit ${r.json.commit ?? 'n/a'}`;
});

check('auth / me', 'Users (role lookup)', async () => {
  const r = await api('GET', '/api/me');
  assert(r.status === 200 && r.json?.ok === true, `expected 200, got ${r.status} ${r.text.slice(0, 120)}`);
  ctx.role = r.json.role;
  assert(r.json.role === 'super_admin' || r.json.role === 'club_admin', `token is not an admin (role=${r.json.role})`);
  return `signed in as ${r.json.email} (${r.json.role}${r.json.clubId ? `, club ${r.json.clubId}` : ''})`;
});

check('rbac: unauthenticated blocked', '—', async () => {
  const r = await api('GET', '/api/admin/users', { token: '' });
  assert(r.status === 401, `expected 401 without a token, got ${r.status}`);
  return 'GET /admin/users → 401 without token (auth gate active)';
});

check('users.list', 'Users', async () => {
  const r = await api('GET', '/api/admin/users');
  assert(r.status === 200 && Array.isArray(r.json?.users), `expected users[], got ${r.status}`);
  return `${r.json.users.length} user(s)`;
});

check('clubs.list', 'Clubs', async () => {
  const r = await api('GET', '/api/admin/clubs');
  assert(r.status === 200 && Array.isArray(r.json?.clubs), `expected clubs[], got ${r.status}`);
  const active = r.json.clubs.find((c) => c.status === 'active');
  ctx.clubForLinks = active?.normalizedName ?? r.json.clubs[0]?.normalizedName ?? null;
  return `${r.json.clubs.length} club(s)`;
});

check('events.list', 'Events (Firestore cache)', async () => {
  const r = await api('GET', '/api/events');
  assert(r.status === 200 && Array.isArray(r.json?.events), `expected events[], got ${r.status}`);
  return `${r.json.events.length} event(s)`;
});

check('links.list', 'Upload_Links', async () => {
  const r = await api('GET', '/api/admin/links');
  assert(r.status === 200 && Array.isArray(r.json?.links), `expected links[], got ${r.status}`);
  return `${r.json.links.length} link(s)`;
});

check('audit.list', 'Audit_Log', async () => {
  const r = await api('GET', '/api/admin/audit?limit=5');
  if (r.status === 403) skip('super_admin only (token is club_admin)');
  assert(r.status === 200 && Array.isArray(r.json?.records), `expected records[], got ${r.status}`);
  assert(typeof r.json.total === 'number', 'missing numeric total');
  return `${r.json.records.length} of ${r.json.total} record(s)`;
});

check('deleted-files.list', 'Deleted_Files', async () => {
  const r = await api('GET', '/api/admin/deleted-files');
  assert(r.status === 200 && Array.isArray(r.json?.files), `expected files[], got ${r.status}`);
  return `${r.json.files.length} record(s)`;
});

check('summary', 'Upload_Log', async () => {
  const r = await api('GET', '/api/admin/summary');
  assert(r.status === 200 && r.json?.totals && typeof r.json.totals.files === 'number', `bad summary shape (${r.status})`);
  const t = r.json.totals;
  return `${t.sessions} sessions, ${t.files} files, ${t.sizeMb} MB`;
});

check('email-prefs', 'Email_Preferences', async () => {
  const r = await api('GET', '/api/admin/email-prefs');
  assert(r.status === 200 && r.json?.prefs, `expected prefs, got ${r.status}`);
  return `dailyReport=${r.json.prefs.dailyReport}`;
});

check('managed-albums link', 'public folder index sheet', async () => {
  const r = await api('GET', '/api/managed-albums');
  assert(r.status === 200 && r.json?.ok === true && 'url' in r.json, `expected {url}, got ${r.status}`);
  return r.json.url ? `published: ${r.json.url}` : 'unset (PUBLIC_FOLDER_INDEX_SHEET_ID blank)';
});

// ── Reversible write cycle (--write) ─────────────────────────────────────────

check('write: club create→readback→deactivate', 'Clubs', async () => {
  if (!DO_WRITE) skip('pass --write to run write checks');
  if (ctx.role !== 'super_admin') skip('club create is super_admin only');
  // normalizedName must match clubStore's NORMALIZED_NAME_RE (alnum + underscores).
  const norm = `zzz_parity_${STAMP}`;
  const c = await api('POST', '/api/admin/clubs', { body: { displayName: `ZZZ Parity ${STAMP}`, normalizedName: norm } });
  assert(c.status === 201 && c.json?.club?.normalizedName === norm, `create failed: ${c.status} ${c.text.slice(0, 160)}`);
  ctx.createdClubNorm = norm;
  const list = await api('GET', '/api/admin/clubs');
  assert(list.json.clubs.some((x) => x.normalizedName === norm), 'created club not found on readback (Sheet write may not have propagated)');
  const d = await api('POST', `/api/admin/clubs/${encodeURIComponent(norm)}/deactivate`, { body: {} });
  assert(d.status === 200 && d.json?.club?.status === 'inactive', `deactivate (cleanup) failed: ${d.status}`);
  return `created + read back + deactivated ${norm}`;
});

check('write: user create→readback→deactivate', 'Users', async () => {
  if (!DO_WRITE) skip('pass --write to run write checks');
  if (ctx.role !== 'super_admin') skip('user create is super_admin only');
  const email = `parity-test+${STAMP}@mmrunners.org`;
  const clubId = ctx.createdClubNorm ?? ctx.clubForLinks ?? '';
  const u = await api('POST', '/api/admin/users', { body: { email, firstName: 'Parity', lastName: 'Test', role: 'club_admin', clubId } });
  assert(u.status === 201 && u.json?.user?.email?.toLowerCase() === email, `create failed: ${u.status} ${u.text.slice(0, 160)}`);
  const list = await api('GET', '/api/admin/users');
  assert(list.json.users.some((x) => x.email?.toLowerCase() === email), 'created user not found on readback');
  const d = await api('POST', `/api/admin/users/${encodeURIComponent(email)}/deactivate`, { body: {} });
  assert(d.status === 200 && d.json?.user?.status === 'inactive', `deactivate (cleanup) failed: ${d.status}`);
  return `created + read back + deactivated ${email}`;
});

check('write: link generate→rotate→revoke', 'Upload_Links', async () => {
  if (!DO_WRITE) skip('pass --write to run write checks');
  if (!EVENT_ID) skip('pass --event=<eventId> to exercise links (no throwaway events are created)');
  const clubName = ctx.clubForLinks;
  assert(clubName, 'no club available to scope the link');
  const g = await api('POST', '/api/admin/links', { body: { eventId: EVENT_ID, clubName, tag: `parity-${STAMP}` } });
  assert(g.status === 201 && g.json?.link?.linkId, `generate failed: ${g.status} ${g.text.slice(0, 160)}`);
  const id = g.json.link.linkId;
  const rot = await api('POST', `/api/admin/links/${encodeURIComponent(id)}/rotate`, { body: {} });
  assert(rot.status === 200 && rot.json?.link?.version > g.json.link.version, `rotate failed: ${rot.status}`);
  // Rotate revokes the old link and mints a NEW linkId — clean up the new one.
  const rotatedId = rot.json.link.linkId;
  const rev = await api('POST', `/api/admin/links/${encodeURIComponent(rotatedId)}/revoke`, { body: { reason: 'parity-check cleanup' } });
  assert(rev.status === 200 && rev.json?.link?.status === 'inactive', `revoke (cleanup) failed: ${rev.status}`);
  return `generated ${id} + rotated → ${rotatedId} + revoked`;
});

check('write: masquerade start→end', 'Audit_Log', async () => {
  if (!DO_WRITE) skip('pass --write to run write checks');
  if (ctx.role !== 'super_admin') skip('masquerade is super_admin only');
  const clubId = ctx.clubForLinks;
  assert(clubId, 'no club available to masquerade as');
  const s = await api('POST', '/api/admin/masquerade/start', { body: { clubId } });
  assert(s.status === 200 && s.json?.actingAsClub === clubId, `start failed: ${s.status}`);
  const e = await api('POST', '/api/admin/masquerade/end', { body: {} });
  assert(e.status === 200, `end failed: ${e.status}`);
  return `start(${clubId}) + end`;
});

check('write: audit reflects writes', 'Audit_Log', async () => {
  if (!DO_WRITE) skip('pass --write to run write checks');
  if (ctx.role !== 'super_admin') skip('audit read is super_admin only');
  const r = await api('GET', '/api/admin/audit?limit=25');
  assert(r.status === 200, `audit read failed: ${r.status}`);
  const hit = r.json.records.some((x) => /CLUB|USER|LINK|MASQUERADE/i.test(x.action || ''));
  assert(hit, 'no recent write actions found in audit log');
  return 'recent write actions present in Audit_Log';
});

// ── Optional: email + partner ────────────────────────────────────────────────

check('email/daily digest', 'Audit_Log + Email_Preferences', async () => {
  if (!DO_EMAIL) skip('pass --email to actually send the digest');
  const r = await api('POST', '/api/admin/email/daily', { body: {} });
  assert(r.status === 200 && r.json?.ok === true, `expected 200 ok, got ${r.status}`);
  // Send failures are non-fatal server-side (logged 200), so a 200 alone can hide
  // a broken mail path — e.g. the Gmail API being disabled on the project.
  assert(
    !(r.json.recipients > 0 && r.json.sent < r.json.recipients),
    `digest under-delivered: sent=${r.json.sent} of recipients=${r.json.recipients} (check api logs for Gmail errors)`,
  );
  return `changes=${r.json.changes} recipients=${r.json.recipients} sent=${r.json.sent}`;
});

check('partner: GET /partner/events', 'Firestore events (read)', async () => {
  if (!PARTNER_KEY) skip('pass --partner-key=<k> to check the partner API');
  const r = await api('GET', '/api/partner/events', { token: '', headers: { 'X-Api-Key': PARTNER_KEY } });
  assert(r.status === 200 && Array.isArray(r.json?.events), `expected events[], got ${r.status}`);
  return `${r.json.events.length} event(s) visible to partner`;
});

// ── Run ──────────────────────────────────────────────────────────────────────

const results = [];
for (const c of checks) {
  try {
    const detail = await c.fn();
    results.push({ id: c.id, sheetTab: c.sheetTab, status: 'PASS', detail });
  } catch (err) {
    if (err instanceof Skip) results.push({ id: c.id, sheetTab: c.sheetTab, status: 'SKIP', detail: err.message });
    else results.push({ id: c.id, sheetTab: c.sheetTab, status: 'FAIL', detail: err.message });
  }
}

const pass = results.filter((r) => r.status === 'PASS').length;
const fail = results.filter((r) => r.status === 'FAIL').length;
const skipped = results.filter((r) => r.status === 'SKIP').length;

if (JSON_OUT) {
  console.log(JSON.stringify({ base: BASE, write: DO_WRITE, pass, fail, skip: skipped, results }, null, 2));
} else {
  const ico = { PASS: '✓', FAIL: '✗', SKIP: '–' };
  const w = Math.max(...results.map((r) => r.id.length));
  console.log(`\nParity check → ${BASE}   (write=${DO_WRITE ? 'on' : 'off'})\n`);
  for (const r of results) {
    console.log(`  ${ico[r.status]} ${r.id.padEnd(w)}  ${r.status === 'PASS' ? '' : `[${r.status}] `}${r.detail}`);
    if (r.sheetTab !== '—') console.log(`     ${' '.repeat(w)}  ↳ Sheet tab: ${r.sheetTab}`);
  }
  console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped of ${results.length}.`);
  if (!DO_WRITE) console.log('Note: read-only run. Re-run with --write (and --event=<id>) to verify Sheet writes.');
  if (fail === 0) console.log('Authoritative parity = eyeball each Sheet tab above against gas-app for one event cycle (CUTOVER_RUNBOOK §B).');
}

process.exit(fail > 0 ? 1 : 0);
