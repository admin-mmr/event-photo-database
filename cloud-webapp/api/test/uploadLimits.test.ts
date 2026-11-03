import { describe, it, expect } from 'vitest';
import express from 'express';
import multer from 'multer';
import request from 'supertest';

import { errorHandler } from '../src/middleware/error.js';

/** A route with a bare multer parser (no withUploadLimits), like adminOutfit:
 *  its limit errors must reach errorHandler and come back as a 4xx, not a 500. */
function appWithBareUpload() {
  const app = express();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10, files: 1 } });
  app.post('/up', upload.array('file', 1), (_req, res) => {
    res.json({ ok: true });
  });
  app.use(errorHandler);
  return app;
}

describe('errorHandler × MulterError', () => {
  const app = appWithBareUpload();

  it('a file over the limit is a 413 file_too_large', async () => {
    const res = await request(app)
      .post('/up')
      .attach('file', Buffer.alloc(11), { filename: 'a.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({ ok: false, error: 'file_too_large' });
    expect(res.body.message).toMatch(/too large/);
  });

  it('too many files is a 413 too_many_files', async () => {
    const res = await request(app)
      .post('/up')
      .attach('file', Buffer.alloc(1), { filename: 'a.jpg', contentType: 'image/jpeg' })
      .attach('file', Buffer.alloc(1), { filename: 'b.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(413);
    expect(res.body.error).toBe('too_many_files');
  });

  it('a file under an unexpected field is a 400 bad_upload', async () => {
    const res = await request(app)
      .post('/up')
      .attach('photo', Buffer.alloc(1), { filename: 'a.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('bad_upload');
  });
});
