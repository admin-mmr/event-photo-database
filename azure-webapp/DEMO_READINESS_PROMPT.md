# Prompt: Verify cloud-webapp is working and demo-ready

You are working in the `cloud-webapp/` directory of the Event Photo Database repo
(GCP edition: Cloud Run API + Vite/React web + Firestore + Cloud Storage, organized
as one npm workspace with `api`, `web`, and `shared` packages).

Your job: confirm the app builds, runs, and demos cleanly end-to-end on a fresh
checkout, fix anything blocking that, and report exactly what a demo can and cannot show.

## Do this in order

1. **Environment check.** Confirm Node 20 (`.nvmrc`), run `npm install` at the root,
   and report any install errors or peer-dependency warnings that matter.

2. **Static health.** Run `npm run check` (tsc + eslint) and `npm test` across all
   workspaces. List every failure with the file, the cause, and the fix. Fix the ones
   blocking a demo; flag the rest.

3. **Local run.** Start `npm run dev` (api on :8080, web on :5173). Verify:
   - `GET /api/health` returns a healthy response.
   - The web app loads at http://localhost:5173 with no console errors.
   - The Vite `/api/*` proxy to :8080 actually works.

4. **Walk the demo path.** Click through the primary user flow as a presenter would.
   Note every screen that renders, every action that works, and every dead end,
   placeholder, or error. Cross-reference the "Migration status from gas-app" table
   in README.md — only ✅ features should be demoed; do not present 🟡/⬜ ones as working.

5. **Config/secrets.** Identify anything required to run that isn't in the repo
   (env vars, GCP project, Firebase config, service-account creds). State whether the
   demo needs live GCP or can run fully local with emulators/mocks.

## Output

Give me:
- **Demo-ready? Yes / No / Yes-with-caveats** — one line up top.
- **What works** — the exact flow I can safely show.
- **What's broken or missing** — ranked by demo impact, each with a proposed fix.
- **What you fixed** — diffs or a summary of changes you made.
- **Setup the presenter needs** — the minimal steps to get it running on a clean machine.

Do not claim something works unless you actually ran it. If you couldn't test a path,
say so explicitly.
