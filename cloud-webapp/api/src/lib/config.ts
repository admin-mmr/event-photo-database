import { z } from 'zod';

/**
 * Environment configuration. Validated once at startup so misconfiguration
 * fails fast instead of leaking out as a confusing 500 hours later.
 *
 * For local dev, copy `api/.env.example` to `api/.env` and fill in values.
 * In production (Cloud Run) these come from `--set-env-vars` and
 * `--set-secrets` flags in `infra/scripts/deploy-api.sh`.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),

  // GCP project this Cloud Run service runs in. Used to construct
  // Firestore/Storage client config. On Cloud Run this is auto-detected
  // from the metadata server, so it's optional in production.
  GCP_PROJECT_ID: z.string().optional(),

  // Firebase Auth project. Usually the same as GCP_PROJECT_ID.
  FIREBASE_PROJECT_ID: z.string().optional(),

  // Set by Cloud Build / GitHub Actions to the commit SHA so /api/health
  // can return a build identifier.
  GIT_COMMIT_SHA: z.string().optional(),

  // Comma-separated list of CORS origins allowed in non-production.
  // In production, traffic comes from the same origin via Firebase Hosting
  // rewrite, so CORS is unnecessary.
  CORS_ORIGINS: z.string().optional(),

  // ── Find Me / indexing (dev plan M1) ──────────────────────────────────
  // Region + job name for the photo-indexer Cloud Run Job.
  GCP_REGION: z.string().default('us-central1'),
  INDEXER_JOB_NAME: z.string().default('photo-indexer'),

  // Admin allowlist for the "Index event" trigger (comma-separated emails).
  ADMIN_EMAILS: z.string().default('admin@mmrunners.org'),

  // Keyless DWD for Drive reads (runbook §G1): the DWD-enabled SA we sign
  // JWTs for, and the Workspace user it impersonates.
  DWD_SA: z.string().default('indexer-runtime@mmr-data-pipeline.iam.gserviceaccount.com'),
  DWD_SUBJECT: z.string().default('admin@mmrunners.org'),

  // ── "Sync with Drive" reconciler (dev plan §8) ────────────────────────
  // The master Google Sheet the gas-app admin workflow writes to (its
  // SPREADSHEET_ID Script Property). Empty until configured — POST
  // /api/admin/sync then 503s with a clear message instead of failing oddly.
  // NOTE: reading this Sheet via the Sheets API needs the
  // `spreadsheets.readonly` scope authorized on the DWD client (runbook §G1
  // granted `drive` only — add the Sheets scope in the Workspace Admin
  // console for the same client id, one-time).
  MASTER_SPREADSHEET_ID: z.string().default(''),
  // Tab names within the master Sheet (gas-app SHEET_NAMES).
  EVENTS_SHEET_NAME: z.string().default('Events'),
  UPLOAD_LINKS_SHEET_NAME: z.string().default('Upload_Links'),
  // Tabs the control-plane admin writes (gas-app SHEET_NAMES). Mirrors the
  // column maps in the *Store services. Writing needs the read/write
  // `spreadsheets` DWD scope (see sheetsService header).
  USERS_SHEET_NAME: z.string().default('Users'),
  CLUBS_SHEET_NAME: z.string().default('Clubs'),
  AUDIT_LOG_SHEET_NAME: z.string().default('Audit_Log'),
  EMAIL_PREFERENCES_SHEET_NAME: z.string().default('Email_Preferences'),
  DELETED_FILES_SHEET_NAME: z.string().default('Deleted_Files'),
  UPLOAD_LOG_SHEET_NAME_REPORT: z.string().default('Upload_Log'),
  // Soft-deleted files become eligible for permanent purge after this many days
  // (gas-app SOFT_DELETE_RETENTION_DAYS). The purge job hard-deletes from Drive.
  SOFT_DELETE_RETENTION_DAYS: z.coerce.number().int().positive().default(30),

  // ── Partner REST API (dev plan G5.3) ──────────────────────────────────────
  // API keys for programmatic partner uploads, as a comma-separated list of
  // `email:key` pairs. The secret lives HERE (env / Secret Manager), never in
  // the world-viewable master Sheet — the Sheet's Users row only records that the
  // email is an api_client. Empty = the partner API is closed (401 for all).
  PARTNER_API_KEYS: z.string().default(''),
  // Partner request budget (Firestore fixed-window), keyed by api-client email.
  PARTNER_RATE_LIMIT: z.coerce.number().int().min(0).default(60),
  PARTNER_RATE_WINDOW_SEC: z.coerce.number().int().positive().default(3600),

  // ── Email notifications (dev plan G4.1) ───────────────────────────────────
  // Transactional + digest email via the Gmail API using the SAME keyless DWD
  // client as Drive/Sheets (cloud-neutral — works unchanged on Azure). Sending
  // is OFF by default so dev/test/demo never send real mail; flip EMAIL_ENABLED
  // to 'true' in prod. Requires the `gmail.send` scope authorized on the DWD
  // client and EMAIL_FROM set to the impersonated sender (defaults to DWD_SUBJECT).
  EMAIL_ENABLED: z.enum(['true', 'false']).default('false'),
  EMAIL_FROM: z.string().default(''),
  // Absolute base URL of the web app, used to build links inside emails. Empty
  // = omit links. e.g. https://mmr-data-pipeline.web.app
  APP_BASE_URL: z.string().default(''),
  // Drive folder under which new event folders (layer-1 `YYYY-MM-DD_Event`) are
  // created when an admin creates an event in cloud-webapp (dev plan G3.1).
  // Empty until configured — POST /api/admin/events then 503s with a clear
  // message instead of dropping the folder at the Drive root. Requires the
  // read/write `drive` DWD scope (see driveService DRIVE_SCOPE_READWRITE).
  EVENTS_ROOT_FOLDER_ID: z.string().default(''),
  // Tab the volunteer upload flow appends a completed-batch summary row to.
  // Mirrors gas-app SHEET_NAMES.UPLOAD_LOG. Writing needs the read/write
  // `spreadsheets` scope on the DWD client (see sheetsService header).
  UPLOAD_LOG_SHEET_NAME: z.string().default('Upload_Log'),
  // Optional shared secret that lets a machine caller (Cloud Scheduler) invoke
  // POST /api/admin/sync via the `X-Sync-Token` header instead of a Firebase
  // admin token. Empty = only Firebase admins can trigger a sync.
  SYNC_TRIGGER_TOKEN: z.string().default(''),

  // ── Volunteer upload background worker (UPLOAD_ASYNC_QUEUE_DESIGN.md) ──
  // When 'true', /complete will (step 3) enqueue a Cloud Tasks task targeting
  // POST /api/internal/process-batch and return `received` immediately, instead
  // of copying to Drive inline. Default 'false' = the current synchronous inline
  // path. The worker endpoint itself exists regardless (added in step 2); this
  // flag only controls how /complete dispatches once Cloud Tasks is wired.
  UPLOAD_DISPATCH_TO_WORKER: z.enum(['true', 'false']).default('false'),
  // Cloud Tasks queue the worker dispatch targets, and the absolute base URL of
  // this api service (the task's HTTP target). All required (plus the flag and
  // SYNC_TRIGGER_TOKEN) for dispatch to be active; otherwise /complete copies
  // inline. LOCATION defaults to the GCP region.
  UPLOAD_TASKS_QUEUE: z.string().default(''),
  UPLOAD_TASKS_LOCATION: z.string().default('us-central1'),
  UPLOAD_WORKER_URL: z.string().default(''),

  // ── Find Me search (dev plan M2) ──────────────────────────────────────
  // Base URL of the private matcher Cloud Run service. Empty until the
  // matcher is deployed — the /api/findme routes 503 with a clear message
  // rather than failing confusingly.
  MATCHER_URL: z.string().default(''),

  // Derivatives bucket (indexer output; gallery + search serving copies).
  DERIVATIVES_BUCKET: z.string().default('mmr-data-pipeline-derivatives'),

  // Uploads bucket: working copies of reference selfies, kept so a signed-in
  // member can reuse a past photo to search a new event (PRD D7/§6.1). Objects
  // live under `find_me_references/<uid>/<uploadId>.<ext>`. Retention is the
  // PRD §8.4 tier (below); a Firestore TTL on `find_me_uploads.expiresAt` plus
  // the M5.1 deletion job / a matching bucket lifecycle do the actual cleanup.
  UPLOADS_BUCKET: z.string().default('mmr-data-pipeline-uploads'),
  REFERENCE_RETENTION_DAYS_ADULT: z.coerce.number().int().positive().default(90),
  REFERENCE_RETENTION_DAYS_MINOR: z.coerce.number().int().positive().default(30),

  // ── Volunteer resumable uploads (UPLOAD_RESUMABLE_NOTES) ──────────────
  // Staging bucket where the browser PUTs raw uploads via a GCS resumable
  // session, BEFORE they are copied into Drive + indexed. Defaults to the
  // DEDICATED `-uploads-staging` bucket that provision-volunteer-uploads.sh
  // creates and applies CORS + the 7-day purge lifecycle to (GCS keeps an
  // unfinalized resumable upload for ~7 days). This MUST match the bucket the
  // provision script targets — they previously disagreed (default pointed at
  // the shared `-uploads` Find Me bucket while CORS landed on `-uploads-staging`),
  // so sessions were minted on a bucket with no CORS rule and every browser PUT
  // failed with "No 'Access-Control-Allow-Origin' header". Objects live under
  // `<prefix>/<eventId>/<batchId>/<uploadId>.<ext>`.
  VOLUNTEER_STAGING_BUCKET: z.string().default('mmr-data-pipeline-uploads-staging'),
  VOLUNTEER_STAGING_PREFIX: z.string().default('volunteer_uploads'),
  // The web origin allowed to PUT chunks to the resumable session. Must match
  // the CORS config applied to the staging bucket (see UPLOAD_RESUMABLE_NOTES).
  // Empty = same-origin prod (Firebase Hosting rewrite) only.
  VOLUNTEER_UPLOAD_ORIGIN: z.string().default(''),
  // Per-link-token rate limit on POST /volunteer/upload/session (one /session
  // call is minted per file). Guards a LEAKED upload link from being used to
  // fill the staging bucket — keyed on the link token, fixed window, fails OPEN
  // like every other limiter. 0 disables. Generous by default so a legitimate
  // large batch (hundreds of photos) is never blocked; tighten in prod if a
  // link is known to be widely shared.
  VOLUNTEER_UPLOAD_LIMIT: z.coerce.number().int().min(0).default(2000),
  VOLUNTEER_UPLOAD_WINDOW_SEC: z.coerce.number().int().positive().default(3600),

  // Signed-URL lifetime. PRD §4.2 caps this at 60 minutes.
  SIGNED_URL_TTL_MINUTES: z.coerce.number().int().positive().max(60).default(60),

  // Active consent policy version recorded with each consent (secret G2).
  CONSENT_POLICY_VERSION: z.string().default('v1-2026-06'),

  // ── Abuse protection (dev plan M5.3 / PRD §9) ─────────────────────────
  // Per-user rate limits, enforced via a Firestore fixed-window counter
  // (middleware/rateLimit.ts). A limit of 0 disables that bucket. The limiter
  // fails OPEN — a Firestore hiccup never blocks a real user.
  // Searches per FINDME_SEARCH_WINDOW_SEC, keyed by uid.
  FINDME_SEARCH_LIMIT: z.coerce.number().int().min(0).default(20),
  FINDME_SEARCH_WINDOW_SEC: z.coerce.number().int().positive().default(60),
  // Bulk ZIP downloads per rolling day, keyed by uid. One ZIP = one logical
  // action regardless of how many photos it contains, so this stays modest.
  DOWNLOAD_LIMIT_PER_DAY: z.coerce.number().int().min(0).default(50),
  // Single-original fetches per rolling day, keyed by uid (its own bucket — dev
  // plan §5B C1). The "Save individually" / "Save to Photos" path fetches each
  // selected photo separately, so ONE user save fans out into N of these. If
  // they shared the bulk DOWNLOAD bucket, a single 22-photo save would burn 22
  // of 50 and lock the user out for the rest of the day. Generous limit + own
  // bucket so a normal multi-photo save never trips it.
  ORIGINAL_FETCH_LIMIT: z.coerce.number().int().min(0).default(500),
  // Client-error reports per window, keyed by uid (POST /api/client-errors).
  // Each accepted report becomes an ERROR log line, which the Cloud Monitoring
  // alert policy turns into an email — so this bucket caps how many alert-worthy
  // logs a single misbehaving (or malicious) client can emit. 0 disables. The
  // window is generous enough for a real burst of failures during one session
  // but low enough that a stuck retry loop can't flood the alert inbox.
  CLIENT_ERROR_LIMIT: z.coerce.number().int().min(0).default(30),
  CLIENT_ERROR_WINDOW_SEC: z.coerce.number().int().positive().default(3600),

  // reCAPTCHA Enterprise on the upload/search action (services/recaptcha.ts).
  // All three must be set to enable verification; otherwise the gate no-ops
  // (so local dev and the demo keep working without a key). The client sends
  // the token in the `X-Recaptcha-Token` header.
  RECAPTCHA_PROJECT_ID: z.string().default(''),
  RECAPTCHA_SITE_KEY: z.string().default(''),
  RECAPTCHA_API_KEY: z.string().default(''),
  // Minimum Enterprise risk score (0..1) to accept; below this is rejected.
  RECAPTCHA_MIN_SCORE: z.coerce.number().min(0).max(1).default(0.5),

  // ── Pilot feature flag (dev plan M6.1 / M6.4) ─────────────────────────
  // Find Me search gate, evaluated per search in `runSearch`. Two knobs:
  //   FINDME_ENABLED          global kill switch ('true' | 'false').
  //   FINDME_EVENT_ALLOWLIST  comma-separated event IDs the search is
  //                           restricted to. EMPTY (default) = every event is
  //                           allowed (current behaviour). Set it to the single
  //                           pilot event id to gate the launch (M6.1); clear it
  //                           for general rollout (M6.4).
  // Both fail OPEN of nothing — defaults leave Find Me fully on, so the demo and
  // existing tests are unaffected until an operator opts into the pilot gate.
  FINDME_ENABLED: z.enum(['true', 'false']).default('true'),
  FINDME_EVENT_ALLOWLIST: z.string().default(''),

  // ── Managed folders / Special folders (gas-app migration) ─────────────────
  // Post-upload "special folders" pipeline: per-event Photos_NNN buckets and
  // per-(event,club,tag) Videos/Album shortcut folders, mirrored to a public
  // folder-index spreadsheet. Master switch OFF by default so an unconfigured
  // deploy is a safe no-op (parity with gas-app's "Script Property unset" path).
  MANAGED_FOLDERS_ENABLED: z.enum(['true', 'false']).default('false'),
  // Tab on the master Sheet holding the authoritative folder state (gas-app
  // Special_Folders). Created on first write if missing.
  SPECIAL_FOLDERS_SHEET_NAME: z.string().default('Special_Folders'),
  // World-readable Google Sheet the public folder index is written to (gas-app
  // PUBLIC_ALBUM_INDEX_SHEET_ID). Empty = public-index rewrite is a no-op.
  PUBLIC_FOLDER_INDEX_SHEET_ID: z.string().default(''),
  // Max files per Photos_NNN bucket before overflowing to the next bucket
  // (gas-app MAX_SHORTCUTS_PER_PHOTOS_FOLDER) — a Drive-UI browse-speed cap.
  MAX_PHOTOS_PER_BUCKET: z.coerce.number().int().positive().default(800),
  // Cloud Run image-convert service (gas-app CLOUD_RUN_URL). Used to materialise
  // non-JPEG photos (PNG/HEIC/WEBP) as real JPGs in the Photos_NNN buckets. Empty
  // = convert disabled, so non-JPEG sources fall back to a shortcut (JPEGs are
  // always shortcuts under the storage-minimizing policy). The api-runtime SA
  // must be allowed to invoke it.
  IMAGE_CONVERT_URL: z.string().default(''),
  IMAGE_CONVERT_JPG_QUALITY: z.coerce.number().int().min(1).max(100).default(85),
});

export type Env = z.infer<typeof EnvSchema>;

export const env: Env = EnvSchema.parse(process.env);

export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

/**
 * Parsed pilot allowlist (trimmed, blanks dropped). Empty array = no event
 * restriction. Computed once at load, like the rest of this module.
 */
export const findMeEventAllowlist: string[] = env.FINDME_EVENT_ALLOWLIST
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * Whether Find Me search is enabled for a given event under the pilot flag
 * (dev plan M6.1). Off entirely when `FINDME_ENABLED=false`; otherwise gated to
 * the allowlist when one is set, and open to all events when it is empty.
 */
export function isFindMeEnabledForEvent(eventId: string): boolean {
  if (env.FINDME_ENABLED === 'false') return false;
  if (findMeEventAllowlist.length === 0) return true;
  return findMeEventAllowlist.includes(eventId);
}
