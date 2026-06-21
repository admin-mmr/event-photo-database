import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { buildServer } from '../src/server.js';
import { HealthResponseSchema } from '@cloud-webapp/shared';

describe('GET /api/health', () => {
  const app = buildServer();

  it('returns a well-formed health response', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    // The contract from shared/ — fail the test if the response shape drifts.
    const parsed = HealthResponseSchema.safeParse(res.body);
    expect(parsed.success).toBe(true);
  });

  it('returns 404 for unknown routes', async () => {
    const res = await request(app).get('/api/this-does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('not_found');
  });
});
