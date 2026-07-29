import './lib/gaxiosNativeFetch.js'; // must run before any google-auth-library / @google-cloud/storage use
import { buildServer } from './server.js';
import { env } from './lib/config.js';
import { initDb } from './lib/firestore.js';
import { initStorage } from './lib/storage.js';
import { logger } from './lib/logger.js';
import { recaptchaConfigStatus } from './services/recaptcha.js';

const app = buildServer();

// Connect the document store and the object store before accepting traffic.
// Both are no-ops on GCP; on Azure they are what load the Cosmos and Blob
// clients (see lib/firestore.ts initDb, lib/storage.ts initStorage).
await Promise.all([initDb(), initStorage()]);

const server = app.listen(env.PORT, () => {
  logger.info(
    { port: env.PORT, env: env.NODE_ENV, cloud: env.CLOUD_PROVIDER },
    'api listening',
  );
  const rc = recaptchaConfigStatus();
  if (rc.partial) {
    logger.warn(
      { recaptcha: rc.present },
      'reCAPTCHA is only PARTIALLY configured — token verification is DISABLED (fail-open). ' +
        'Set RECAPTCHA_PROJECT_ID, RECAPTCHA_SITE_KEY and RECAPTCHA_API_KEY (check the secret env-var name).',
    );
  } else if (rc.configured) {
    logger.info('reCAPTCHA token verification enabled');
  } else {
    logger.info('reCAPTCHA not configured — token verification disabled (expected in local/dev)');
  }
});

// Cloud Run sends SIGTERM ~10s before killing the container on a new
// revision rollout. Stop accepting new connections, finish in-flight
// requests, then exit. Without this, in-flight requests get TCP-reset.
function shutdown(signal: string): void {
  logger.info({ signal }, 'shutdown initiated');
  server.close((err) => {
    if (err) {
      logger.error({ err }, 'error during shutdown');
      process.exit(1);
    }
    logger.info('shutdown complete');
    process.exit(0);
  });
  // Hard-kill after 10s if a hung connection refuses to close.
  setTimeout(() => {
    logger.warn('shutdown timeout — forcing exit');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
