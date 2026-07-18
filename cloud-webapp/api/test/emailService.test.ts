import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// EMAIL_ENABLED defaults to 'false', so sendEmail no-ops without a network call.
const { buildRawMessage, encodeHeaderValue, sendEmail, sendToMany, emailFrom } = await import(
  '../src/services/emailService.js'
);

const content = { subject: 'Hi there', html: '<p>hello</p>', text: 'hello' };

describe('buildRawMessage', () => {
  it('encodes an RFC-822 multipart message with headers + both parts', () => {
    const raw = buildRawMessage('a@x.org', content);
    const decoded = Buffer.from(raw, 'base64url').toString('utf8');
    expect(decoded).toContain('To: a@x.org');
    expect(decoded).toContain('Subject: Hi there');
    expect(decoded).toContain('multipart/alternative');
    expect(decoded).toContain('hello'); // text part
    expect(decoded).toContain('<p>hello</p>'); // html part
    expect(decoded).toContain(`From: ${emailFrom()}`);
  });

  it('RFC 2047-encodes a non-ASCII subject (em dash), leaving ASCII alone', () => {
    const subject = 'Event Photo Database daily digest — 16 changes';
    const raw = buildRawMessage('a@x.org', { ...content, subject });
    const decoded = Buffer.from(raw, 'base64url').toString('utf8');
    expect(decoded).not.toContain(`Subject: ${subject}`);
    const encoded = decoded.match(/^Subject: (.+(?:\r\n .+)*)/m)?.[1] ?? '';
    const roundTripped = encoded
      .split(/\r\n /)
      .map((w) => Buffer.from(w.replace(/^=\?UTF-8\?B\?/, '').replace(/\?=$/, ''), 'base64').toString('utf8'))
      .join('');
    expect(roundTripped).toBe(subject);
  });
});

describe('encodeHeaderValue', () => {
  it('passes ASCII through untouched', () => {
    expect(encodeHeaderValue('Hi there')).toBe('Hi there');
  });

  it('splits long values into <=75-char encoded-words on whole characters', () => {
    const value = '照片'.repeat(40);
    const encoded = encodeHeaderValue(value);
    const words = encoded.split('\r\n ');
    expect(words.length).toBeGreaterThan(1);
    for (const w of words) {
      expect(w.length).toBeLessThanOrEqual(75);
      expect(w).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/]+={0,2}\?=$/);
    }
    const roundTripped = words
      .map((w) => Buffer.from(w.slice(10, -2), 'base64').toString('utf8'))
      .join('');
    expect(roundTripped).toBe(value);
  });
});

describe('sendEmail (disabled by default)', () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  beforeEach(() => fetchSpy.mockClear());
  afterEach(() => fetchSpy.mockReset());

  it('no-ops and never calls the network when EMAIL_ENABLED!=true', async () => {
    expect(await sendEmail('a@x.org', content)).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns false for a blank recipient', async () => {
    expect(await sendEmail('', content)).toBe(false);
  });

  it('sendToMany returns 0 when sending is disabled', async () => {
    expect(await sendToMany(['a@x.org', 'b@x.org'], content)).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
