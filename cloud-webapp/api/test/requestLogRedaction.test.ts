import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import type * as LoggerModule from '../src/lib/logger.js';

// pino-http writes every request header into the `request completed` line, and
// Cloud Logging is readable by project members. On 2026-11-02 production logs
// were found to hold live Firebase ID tokens in `authorization`. These tests
// drive the real server through a logger built from the real options, over a
// stream we can read, and assert that no credential value survives.
const captured = vi.hoisted(() => ({ lines: [] as string[] }));

vi.mock('../src/lib/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof LoggerModule>();
  const { pino } = await import('pino');
  const { Writable } = await import('node:stream');
  const sink = new Writable({
    write(chunk, _enc, cb) {
      captured.lines.push(String(chunk));
      cb();
    },
  });
  return { ...actual, logger: pino(actual.loggerOptions, sink) };
});

const { buildServer } = await import('../src/server.js');
const { REDACTED } = await import('../src/lib/logger.js');

const SECRETS = {
  Authorization: 'Bearer eyJhbGciOiJSUzI1NiJ9.firebase-id-token-SECRET.sig',
  'X-Sync-Token': 'sync-token-SECRET-value',
  'X-Recaptcha-Token': 'recaptcha-token-SECRET-value',
  'X-Api-Key': 'partner-api-key-SECRET-value',
  Cookie: 'session=cookie-SECRET-value',
  'Proxy-Authorization': 'Basic proxy-SECRET-value',
};

async function requestLogFor(path: string): Promise<Record<string, unknown>> {
  await request(buildServer())
    .get(path)
    .set(SECRETS)
    .set('X-Forwarded-For', '203.0.113.7, 10.0.0.1')
    .set('User-Agent', 'redaction-test/1.0');
  // pino-http logs on the response's finish event; give it a turn to land.
  let line: string | undefined;
  await vi.waitFor(() => {
    line = captured.lines.find((l) => l.includes('"request completed"'));
    expect(line).toBeDefined();
  });
  return JSON.parse(line!) as Record<string, unknown>;
}

describe('request log redaction', () => {
  beforeEach(() => {
    captured.lines.length = 0;
  });

  it('writes no credential value anywhere in the log output', async () => {
    await requestLogFor('/api/this-does-not-exist');
    const output = captured.lines.join('');
    expect(output).toContain('request completed');
    for (const value of Object.values(SECRETS)) {
      expect(output).not.toContain(value);
    }
    expect(output).not.toContain('SECRET');
  });

  it('keeps each credential header key, with its value replaced', async () => {
    const entry = await requestLogFor('/api/this-does-not-exist');
    const headers = (entry['req'] as { headers: Record<string, string> }).headers;
    for (const name of Object.keys(SECRETS)) {
      expect(headers[name.toLowerCase()]).toBe(REDACTED);
    }
  });

  it('still logs x-forwarded-for and the other non-secret headers', async () => {
    const entry = await requestLogFor('/api/this-does-not-exist');
    const headers = (entry['req'] as { headers: Record<string, string> }).headers;
    expect(headers['x-forwarded-for']).toBe('203.0.113.7, 10.0.0.1');
    expect(headers['user-agent']).toBe('redaction-test/1.0');
  });
});
