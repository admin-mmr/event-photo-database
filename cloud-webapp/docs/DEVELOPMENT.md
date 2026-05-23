# Development guide

How to run cloud-webapp locally and the conventions to follow when adding to it.

---

## First-time setup on a new machine

```bash
# Install Node 20 via nvm
nvm install
nvm use

# Install all workspace dependencies
cd cloud-webapp
npm install

# Authenticate gcloud for local Firestore access via ADC
gcloud auth login
gcloud auth application-default login

# Copy env template
cp api/.env.example api/.env
# Edit api/.env and set GCP_PROJECT_ID to your project
```

---

## Daily workflow

Start both api and web in one terminal:

```bash
npm run dev
```

This launches:

- `api/` on <http://localhost:8080> (auto-reload via `tsx watch`)
- `web/` on <http://localhost:5173> (Vite HMR)

The Vite dev server proxies `/api/*` to `http://localhost:8080`, so the
React code calls `/api/health` as a relative URL exactly like in production.

---

## Testing

```bash
# All tests
npm test

# Just the api
npm test -w @cloud-webapp/api

# Just the web (Vitest + jsdom + @testing-library/react)
npm test -w @cloud-webapp/web

# Watch mode (per workspace)
cd api && npm test -- --watch
```

Coverage reports are emitted into each workspace's `coverage/` folder.

---

## Adding a new API endpoint

1. Define the request/response shape in `shared/src/schemas/<name>.ts` using Zod.
2. Re-export it from `shared/src/index.ts`.
3. Create `api/src/routes/<name>.ts`:
   ```ts
   import { Router } from 'express';
   import { MySchema } from '@cloud-webapp/shared';

   export const myRouter = Router();
   myRouter.post('/things', async (req, res) => {
     const body = MySchema.parse(req.body);
     // …
     res.json({ ok: true });
   });
   ```
4. Register it in `api/src/server.ts`:
   ```ts
   app.use('/api', myRouter);
   ```
5. Add a test in `api/test/<name>.test.ts` using `supertest`.

If the endpoint touches user data, wrap the handler with `requireAuth`
from `middleware/auth.ts`.

---

## Adding a new frontend page

1. Create `web/src/pages/MyPage.tsx`.
2. Wire it in `web/src/App.tsx` (add `react-router-dom` routes when you go past one page).
3. Use `apiGet` / `apiPost` from `web/src/lib/api.ts` to call the api.
4. Import the response type from `@cloud-webapp/shared` so the response
   shape is type-checked at the boundary.

---

## Code style

- ESLint + Prettier enforce style. Run `npm run format` before commit.
- TypeScript `strict` is on. Don't use `any`; if you must, leave a comment.
- Error envelopes: always return `{ ok: false, error: string, message: string }`
  on failure (see `shared/src/schemas/common.ts`). Match the gas-app shape
  so migration tooling can dual-call both backends.

---

## Talking to Firestore locally

By default, `npm run dev` talks to the *real* Firestore in your GCP project
via Application Default Credentials. Be careful — writes go to production
data unless you point a different project.

To run against the Firestore emulator instead:

```bash
# In one terminal
firebase emulators:start --only firestore --project=demo-test

# In another, set the env var before npm run dev
export FIRESTORE_EMULATOR_HOST=localhost:8081
npm run dev
```

The `@google-cloud/firestore` client picks up `FIRESTORE_EMULATOR_HOST`
automatically and routes all traffic to the emulator.

---

## Common gotchas

- **`Cannot find module '@cloud-webapp/shared'`** — run `npm install` from
  the `cloud-webapp/` root (not inside `api/` or `web/`). Workspaces are
  resolved at the root, not per-package.
- **`npm run dev` exits immediately with no output** — Node version
  mismatch. Run `nvm use` to pick up `.nvmrc`.
- **Health check works but auth-gated routes fail locally** — ADC isn't
  set. Run `gcloud auth application-default login`.
