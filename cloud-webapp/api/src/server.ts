import express from 'express';
import type { Request } from 'express';
import { pinoHttp } from 'pino-http';
import { logger } from './lib/logger.js';
import { env, isProd } from './lib/config.js';
import { healthRouter } from './routes/health.js';
import { eventsRouter } from './routes/events.js';
import { galleryRouter } from './routes/gallery.js';
import { findmeRouter } from './routes/findme.js';
import { adminFindmeRouter } from './routes/adminFindme.js';
import { downloadRouter } from './routes/download.js';
import { feedbackRouter } from './routes/feedback.js';
import { metricsRouter } from './routes/metrics.js';
import { syncRouter } from './routes/sync.js';
import { volunteerUploadRouter } from './routes/volunteerUpload.js';
import { telemetryRouter } from './routes/telemetry.js';
import { adminUsersRouter } from './routes/adminUsers.js';
import { adminClubsRouter } from './routes/adminClubs.js';
import { adminMasqueradeRouter } from './routes/adminMasquerade.js';
import { adminEventsRouter } from './routes/adminEvents.js';
import { adminLinksRouter } from './routes/adminLinks.js';
import { auditRouter } from './routes/audit.js';
import { emailPrefsRouter } from './routes/emailPrefs.js';
import { emailDigestRouter } from './routes/emailDigest.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';

export function buildServer(): express.Express {
  const app = express();

  // Trust the Cloud Run / Firebase Hosting proxy chain so `req.ip` and
  // `req.protocol` reflect the original client.
  app.set('trust proxy', true);

  // JSON body parsing with a sane limit. The image-conversion service in
  // ../cloud-run/ uses multipart for the actual file payload — this api
  // only handles metadata, so 1 MB is plenty.
  app.use(express.json({ limit: '1mb' }));

  // Request logging. In Cloud Run this becomes one structured log entry
  // per request, automatically correlated with the trace ID.
  app.use(
    pinoHttp({
      logger,
      // Cloud Run sets X-Cloud-Trace-Context; pino-http will pick it up.
      customLogLevel: (_req, res, err) => {
        if (err || (res.statusCode ?? 0) >= 500) return 'error';
        if ((res.statusCode ?? 0) >= 400) return 'warn';
        return 'info';
      },
      // Don't log health probes at info level — they spam the log.
      autoLogging: {
        ignore: (req: Request) => req.url === '/api/health',
      },
    }),
  );

  // Optional dev-only CORS. In production, traffic is same-origin via
  // Firebase Hosting rewrites, so we deliberately don't ship any CORS
  // headers in prod.
  if (!isProd && env.CORS_ORIGINS) {
    const allowed = env.CORS_ORIGINS.split(',').map((s) => s.trim());
    app.use((req, res, next) => {
      const origin = req.headers.origin;
      if (origin && allowed.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
      }
      if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
      }
      next();
    });
  }

  // Mount routes under /api so Firebase Hosting can rewrite that prefix
  // unchanged. Add new routers here.
  app.use('/api', healthRouter);
  app.use('/api', eventsRouter);
  app.use('/api', galleryRouter);
  app.use('/api', findmeRouter);
  app.use('/api', adminFindmeRouter);
  app.use('/api', downloadRouter);
  app.use('/api', feedbackRouter);
  app.use('/api', metricsRouter);
  app.use('/api', syncRouter);
  app.use('/api', volunteerUploadRouter);
  app.use('/api', telemetryRouter);
  app.use('/api', adminUsersRouter);
  app.use('/api', adminClubsRouter);
  app.use('/api', adminMasqueradeRouter);
  app.use('/api', adminEventsRouter);
  app.use('/api', adminLinksRouter);
  app.use('/api', auditRouter);
  app.use('/api', emailPrefsRouter);
  app.use('/api', emailDigestRouter);

  // 404 + final error handler must be registered last.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
