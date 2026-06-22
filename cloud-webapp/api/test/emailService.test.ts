import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// EMAIL_ENABLED defaults to 'false', so sendEmail no-ops without a network call.
const { buildRawMessage, sendEmail, sendToMany, emailFrom } = await import('../src/services/emailService.js');

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
