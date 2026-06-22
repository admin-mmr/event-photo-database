import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

process.env.MASTER_SPREADSHEET_ID = 'sheet1';
process.env.PARTNER_API_KEYS = 'partner@x.org:secretkey';
process.env.APP_BASE_URL = 'https://app.example';

const getUserByEmail = vi.fn(async () => ({ email: 'partner@x.org', role: 'api_client', status: 'active', clubId: 'CHI' }));
vi.mock('../src/services/userStore.js', () => ({ getUserByEmail: (...a: unknown[]) => getUserByEmail(...(a as [])) }));

const generateLink = vi.fn(async (...a: unknown[]) => {
  const input = a[1] as { eventId: string; clubName: string; tag?: string };
  return { linkId: 'l1', eventId: input.eventId, clubName: input.clubName, token: 'TOKEN123', version: 1, tag: input.tag ?? 'ALL', status: 'active' };
});
vi.mock('../src/services/linkStore.js', () => ({
  generateLink: (...a: unknown[]) => (generateLink as (...x: unknown[]) => unknown)(...a),
}));

const recordAudit = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock('../src/services/auditStore.js', () => ({ recordAudit: (...a: unknown[]) => recordAudit(...a) }));

vi.mock('../src/lib/firestore.js', () => ({
  firestore: () => ({
    collection: () => ({
      get: async () => ({ docs: [{ id: 'ev1', data: () => ({ name: 'Spring', date: '2026-04-01' }) }] }),
    }),
  }),
}));

const { buildServer } = await import('../src/server.js');

describe('partner API', () => {
  const app = buildServer();
  beforeEach(() => {
    getUserByEmail.mockClear();
    generateLink.mockClear();
    recordAudit.mockClear();
    getUserByEmail.mockResolvedValue({ email: 'partner@x.org', role: 'api_client', status: 'active', clubId: 'CHI' });
  });

  it('rejects missing/invalid API key', async () => {
    expect((await request(app).get('/api/partner/events')).status).toBe(401);
    expect((await request(app).get('/api/partner/events').set('X-Api-Key', 'wrong')).status).toBe(401);
  });

  it('rejects a non-active api_client', async () => {
    getUserByEmail.mockResolvedValue({ email: 'partner@x.org', role: 'club_admin', status: 'active', clubId: 'CHI' });
    const res = await request(app).get('/api/partner/events').set('X-Api-Key', 'secretkey');
    expect(res.status).toBe(403);
  });

  it('lists events for a valid key', async () => {
    const res = await request(app).get('/api/partner/events').set('X-Api-Key', 'secretkey');
    expect(res.status).toBe(200);
    expect(res.body.events[0]).toMatchObject({ eventId: 'ev1', name: 'Spring' });
  });

  it('mints an upload link scoped to the partner club', async () => {
    const res = await request(app).post('/api/partner/links').set('X-Api-Key', 'secretkey').send({ eventId: 'ev1' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ token: 'TOKEN123', clubName: 'CHI', uploadUrl: 'https://app.example/upload/TOKEN123' });
    // clubName comes from the api_client's clubId, never the request body.
    expect(generateLink.mock.calls[0]?.[1]).toMatchObject({ eventId: 'ev1', clubName: 'CHI' });
    expect(recordAudit).toHaveBeenCalledTimes(1);
  });
});
