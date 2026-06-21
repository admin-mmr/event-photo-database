# Cloud-webapp deploy fixes + the `shared` runtime-entry change

Handoff notes for the Google Cloud deploy of `cloud-webapp/`. Part 1 is the
pending change to make. Part 2 records what was already fixed so a new thread
has the full picture.

---

## Part 1 — Pending change: point `shared`'s entry at built JS

### The problem (latent, not yet biting us)

`cloud-webapp/shared/package.json` currently resolves the package to **TypeScript
source**:

```json
{
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  }
}
```

Today this is harmless because the only place `api` pulls from `shared` is a
**type-only** import:

```ts
// api/src/routes/health.ts
import type { HealthResponse } from '@cloud-webapp/shared';
```

`import type` is erased at compile time, so the emitted `api/dist/*.js` never
actually `require()`s `@cloud-webapp/shared` at runtime. Node never tries to
load the `.ts` file, so nothing breaks.

### When it WILL break

The moment anyone imports a **runtime value** (not just a type) from `shared`
into `api/src` — for example the Zod schema:

```ts
import { HealthResponseSchema } from '@cloud-webapp/shared'; // value, not type
```

…the compiled `api/dist` will contain a real `require('@cloud-webapp/shared')`.
At runtime in the Cloud Run image, Node resolves that to `shared`'s `main`,
which points at `./src/index.ts`. **Node cannot execute `.ts` files**, so the
container crashes on startup / first request.

### The fix

Point `shared`'s runtime entry at the **compiled** output, while keeping types
pointed at source (so editor/TS project references still work during dev). Make
`shared/package.json` look like this:

```json
{
  "name": "@cloud-webapp/shared",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -b",
    "typecheck": "tsc --noEmit",
    "lint": "echo 'no lint config yet for shared'"
  }
}
```

Key points:

- `main` / `import` → `./dist/index.js` so Node loads real JavaScript at runtime.
- `types` → `./dist/index.d.ts` so TypeScript still gets declarations.
- Adding a `build` script (`tsc -b`) means the root `npm run build --workspaces`
  stops silently skipping `shared` (it had no `build` script before).

### Things to check after making the change

1. `shared/dist/` must exist before anything resolves the package at runtime.
   The Docker build already produces it via `tsc -b` (see Part 2), and the
   runtime stage copies the whole `shared/` dir, so `dist/` is present in the
   image.
2. Because `shared` is `"type": "module"`, the emitted `dist/index.js` is ESM —
   fine, since `api` is also `"type": "module"`.
3. Re-run a clean build to confirm nothing else assumed the source path:
   ```bash
   cd cloud-webapp
   npm run build -w @cloud-webapp/shared
   npm run check
   npm test
   ```
4. Optionally add a value import from `shared` into `api/src` and deploy, to
   prove the runtime path works end to end (this is the scenario that would
   have crashed before the change).

---

## Part 2 — Deploy fixes already applied this session

These three files were changed to get `./infra/scripts/deploy-api.sh` working on
a freshly bootstrapped GCP project. Context for anyone picking this up.

### 1. `api/package.json` — build referenced projects

- **Was:** `"build": "tsc -p tsconfig.build.json"`
- **Now:** `"build": "tsc -b tsconfig.build.json"`
- **Why:** `api` references `shared` as a TypeScript *composite* project, so it
  typechecks/compiles against `shared/dist`. `tsc -p` does **not** build
  referenced projects; `tsc -b` (build mode) builds `shared` first, then `api`.
  This was causing `error TS6305: Output file '.../shared/dist/index.d.ts' has
  not been built…` both locally and inside the Docker build.

### 2. `infra/scripts/deploy-api.sh` — Cloud Build invocation

Two fixes to the `gcloud builds submit` call:

- Removed `--tag`. The script passes an inline build `--config`, and gcloud
  rejects using `--tag` and `--config` together ("At most one of --config |
  --pack | --tag can be specified"). The `--config` is the one we need because
  the build must run from the repo root with `-f api/Dockerfile` so the
  `shared/` workspace is included in the build context.
- Stopped piping the config via stdin (`--config=-`). This gcloud version
  errors with "Unable to read file [-]". The script now writes the config to a
  temp file (`mktemp`, cleaned up on exit) and passes `--config="$TMPFILE"`.

### 3. `infra/scripts/bootstrap-gcp.sh` — Cloud Build IAM

- Added a step granting the **default Compute Engine service account**
  (`<project-number>-compute@developer.gserviceaccount.com`) two roles:
  `roles/cloudbuild.builds.builder` and `roles/artifactregistry.writer`.
- **Why:** `gcloud builds submit` runs as that compute SA. On recently created
  projects it isn't granted the build role automatically, so the first build
  fails with a 403 reading the source tarball from the `*_cloudbuild` bucket
  (`storage.objects.get … denied`). The grant fixes it for clean setups.

> If you set up the project before this change, the two grants may already have
> been applied by hand. Re-running `bootstrap-gcp.sh` is idempotent and safe.

### Note on `dist/` and Cloud Build

`dist/` is (correctly) gitignored — it's build output. `gcloud builds submit`
uploads source respecting `.gitignore`, so `shared/dist/` is **not** shipped to
the build; the container rebuilds it. Keep `dist/` ignored — the fix is to have
the container build `shared` (the `tsc -b` change), **not** to commit/upload
`dist/`.

---

## Deploy commands (reference)

```bash
cd cloud-webapp
export PROJECT_ID="mmr-data-pipeline"

# one-time, idempotent
./infra/scripts/bootstrap-gcp.sh "$PROJECT_ID" us-central1

# backend → Cloud Run
./infra/scripts/deploy-api.sh "$PROJECT_ID" us-central1

# frontend → Firebase Hosting (+ Firestore/Storage rules)
./infra/scripts/deploy-web.sh "$PROJECT_ID"
```

That output cracks it. There's no `restrictServiceUsage` policy (the NOT_FOUND confirms it), so service usage isn't the block. The culprit is right at the top of your list: **`iam.allowedPolicyMemberDomains`** — Domain Restricted Sharing, the same policy that blocked public Cloud Run earlier.

Here's why it breaks `addFirebase` specifically: attaching Firebase to a project automatically grants IAM roles to several **Google-owned service accounts** (Firebase's service agents), which live outside `mmrunners.org`. DRS forbids IAM bindings to any principal outside your allowed domains, so the whole `addFirebase` operation gets denied — even for you as org admin. It's not denying *you*, it's denying the bindings Firebase needs to create.

The fix is to add a **project-level override** that relaxes DRS for `mmr-data-pipeline`, run `addFirebase`, then restore. You have `orgpolicy.policyAdmin` now, so you can do this.

**1. Write an override policy that allows all domains for this one project:**

```
cat > /tmp/allow-all-domains.yaml <<'EOF'
name: projects/mmr-data-pipeline/policies/iam.allowedPolicyMemberDomains
spec:
  rules:
    - allowAll: true
EOF
```

**2. Apply it:**

```
gcloud org-policies set-policy /tmp/allow-all-domains.yaml
```

**3. Wait ~1–2 minutes** for it to propagate, then attach Firebase:

```
firebase projects:addfirebase mmr-data-pipeline
```

That should now succeed. Then continue with what was blocked:

```
firebase hosting:sites:create mmr-data-pipeline --project=mmr-data-pipeline
./infra/scripts/deploy-web.sh mmr-data-pipeline
```

**4. Restore the policy afterward (recommended).** Once Firebase is attached, the bindings persist, so you can re-tighten DRS:

```
gcloud org-policies delete constraints/iam.allowedPolicyMemberDomains --project=mmr-data-pipeline
```

That deletes the project override and the project falls back to inheriting the org's restrictive policy again.

A decision point worth flagging now, while you're in here: that **same DRS policy will block the `/api/*` Firebase Hosting rewrite** (it needs `allUsers` invoker on Cloud Run, which DRS forbids). You have two clean choices:

- Leave the project override in place permanently (don't do step 4), which lets you make the Cloud Run service public and the rewrite "just works" — but it weakens DRS for this whole project.
- Keep DRS tight (do step 4) and have the SPA authenticate API calls with a Firebase Auth token instead of relying on anonymous Hosting rewrites — which fits your migration roadmap anyway.

Run steps 1–3 and tell me what `addfirebase` says. Then I'll help you wire up whichever `/api/*` approach you prefer.