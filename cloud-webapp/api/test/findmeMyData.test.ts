import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import type { Request, Response, NextFunction } from 'express';

vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: (req: Request, res: Response, next: NextFunction) => {
    const raw = req.headers['x-test-user'];
    if (!raw) {
      res.status(401).json({ ok: false, error: 'unauthorized', message: 'Missing bearer token' });
      return;
    }
    req.user = JSON.parse(String(raw));
    next();
  },
}));

const deleteAllUserData = vi.fn();
vi.mock('../src/services/userData.js', () => ({
  deleteAllUserData: (...a: unknown[]) => deleteAllUserData(...(a as [])),
}));

const { buildServer } = await import('../src/server.js');
const app = buildServer();
const USER = JSON.stringify({ uid: 'u1', email: 'm@x', emailVerified: true });

beforeEach(() => {
  deleteAllUserData.mockReset();
});

describe('DELETE /api/findme/me/data (M5.2)', () => {
  it('requires auth', async () => {
    const res = await request(app).delete('/api/findme/me/data');
    expect(res.status).toBe(401);
    expect(deleteAllUserData).not.toHaveBeenCalled();
  });

  it("erases the caller's data and returns the counts", async () => {
    deleteAllUserData.mockResolvedValue({ references: 2, consents: 3, matchRuns: 1, feedback: 4 });
    const res = await request(app).delete('/api/findme/me/data').set('x-test-user', USER);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      deleted: { references: 2, consents: 3, matchRuns: 1, feedback: 4 },
    });
    // Scoped to the authenticated uid + email.
    expect(deleteAllUserData).toHaveBeenCalledWith('u1', 'm@x');
  });
});
