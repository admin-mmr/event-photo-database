import { describe, it, expect } from 'vitest';
import type { LinkRecord } from '@cloud-webapp/shared';
import { buildLinksMessage, shareableLinks } from './linksMessage.js';

function link(over: Partial<LinkRecord>): LinkRecord {
  return {
    linkId: 'l1',
    eventId: 'ev1',
    clubName: 'club',
    token: 'tok',
    version: 1,
    generatedBy: '',
    generatedAt: '',
    revokedAt: '',
    revokedBy: '',
    revokedReason: '',
    tag: '',
    status: 'active',
    ...over,
  };
}

describe('shareableLinks', () => {
  it('drops revoked links — their tokens reject uploads', () => {
    const out = shareableLinks([link({ token: 'live' }), link({ token: 'dead', status: 'inactive' })]);
    expect(out.map((l) => l.token)).toEqual(['live']);
  });

  it('orders by club display name, then tag (club-level link first)', () => {
    const names = new Map([
      ['zz', 'Alpha Runners'],
      ['aa', 'Zeta Club'],
    ]);
    const out = shareableLinks(
      [
        link({ token: 'z-tag', clubName: 'aa', tag: 'mile_5' }),
        link({ token: 'a-tag', clubName: 'zz', tag: 'finish' }),
        link({ token: 'a-club', clubName: 'zz', tag: '' }),
      ],
      names,
    );
    expect(out.map((l) => l.token)).toEqual(['a-club', 'a-tag', 'z-tag']);
  });

  it('does not mutate the caller’s array', () => {
    const input = [link({ token: 'b', clubName: 'b' }), link({ token: 'a', clubName: 'a' })];
    shareableLinks(input);
    expect(input.map((l) => l.token)).toEqual(['b', 'a']);
  });
});

describe('buildLinksMessage', () => {
  const base = {
    eventName: '2026 NYC Marathon',
    eventId: 'ev-1',
    origin: 'https://example.web.app/',
  };

  it('lists every active link with club, tag and full upload URL', () => {
    const msg = buildLinksMessage({
      ...base,
      links: [link({ clubName: 'mmr', tag: 'mile_5', token: 'abc' }), link({ clubName: 'x', token: 'gone', status: 'inactive' })],
      clubDisplayNames: new Map([['mmr', 'MMR Runners']]),
    });
    expect(msg).toContain('🌹 1｜俱乐部 Club：MMR Runners');
    expect(msg).toContain('🏷️ 标签 Tag：mile_5');
    expect(msg).toContain('📤 https://example.web.app/upload/abc');
    expect(msg).not.toContain('gone');
  });

  it('omits the tag line for a club-level link and falls back to the raw club id', () => {
    const msg = buildLinksMessage({ ...base, links: [link({ clubName: 'raw_club', token: 't' })] });
    expect(msg).toContain('俱乐部 Club：raw_club');
    expect(msg).not.toContain('标签 Tag');
  });

  it('is bilingual and points Find Me at this event', () => {
    const msg = buildLinksMessage({ ...base, links: [] });
    expect(msg).toContain('一键找我 · Find Me');
    expect(msg).toContain('Upload with the link');
    expect(msg).toContain('👉 https://example.web.app/events/ev-1/findme');
    expect(msg).toContain('No active upload links yet');
  });
});
