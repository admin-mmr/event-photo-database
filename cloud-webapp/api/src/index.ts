import { buildServer } from './server.js';
import { env } from './lib/config.js';
import { logger } from './lib/logger.js';

const app = buildServer();

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV }, 'api listening');
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
