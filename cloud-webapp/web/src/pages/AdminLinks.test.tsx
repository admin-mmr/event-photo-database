/**
 * <AdminLinks /> — the share message. What matters: it lists the event's live
 * links under the club's display name and the event's real name, and a message
 * built from old tokens is dropped once a rotate changes them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

vi.mock('../lib/firebase.js', () => ({ idToken: async () => 'fake-token' }));

const { AdminLinks } = await import('./AdminLinks.js');

const link = (over: Record<string, unknown>): Record<string, unknown> => ({
  linkId: 'l1',
  eventId: 'ev1',
  clubName: 'mmr',
  token: 'tok-live',
  version: 1,
  tag: 'mile_5',
  status: 'active',
  ...over,
});

const LINKS = {
  ok: true,
  links: [link({}), link({ linkId: 'l2', token: 'tok-revoked', status: 'inactive' })],
};
const CLUBS = {
  ok: true,
  clubs: [{ normalizedName: 'mmr', displayName: 'MMR Runners', status: 'active' }],
};
const EVENT = { ok: true, event: { id: 'ev1', name: '2026 NYC Marathon', date: '2026-11-01' } };

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

function mockApi(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/api/admin/links/') && u.endsWith('/rotate')) return json({ ok: true, link: link({}) });
      if (u.includes('/api/admin/links')) return json(LINKS);
      if (u.includes('/api/admin/clubs')) return json(CLUBS);
      return json(EVENT);
    }),
  );
}

const renderPage = (): void => {
  render(
    <MemoryRouter initialEntries={['/admin/events/ev1/links']}>
      <Routes>
        <Route path="/admin/events/:eventId/links" element={<AdminLinks />} />
      </Routes>
    </MemoryRouter>,
  );
};

const messageBox = (): HTMLTextAreaElement | null =>
  screen.queryByRole('textbox', { name: /share message text/i }) as HTMLTextAreaElement | null;

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('<AdminLinks /> share message', () => {
  it('builds a bilingual message of the active links with club and event names', async () => {
    mockApi();
    renderPage();
    await screen.findAllByText('mile_5', { selector: 'td' });
    // The club map and event name arrive after the links; regenerate until both landed.
    await waitFor(() => {
      fireEvent.click(screen.getByRole('button', { name: /generate message/i }));
      expect(messageBox()!.value).toContain('MMR Runners');
      expect(messageBox()!.value).toContain('2026 NYC Marathon');
    });

    const text = messageBox()!.value;
    expect(text).toContain('📸 2026 NYC Marathon');
    expect(text).toContain('俱乐部 Club：MMR Runners');
    expect(text).toContain('/upload/tok-live');
    expect(text).not.toContain('tok-revoked');
    expect(text).toContain('/events/ev1/findme');
    expect(screen.getByRole('button', { name: /copy message/i })).toBeTruthy();
  });

  it('drops the message after a rotate, so stale tokens cannot be copied', async () => {
    mockApi();
    renderPage();
    await screen.findAllByText('mile_5', { selector: 'td' });

    fireEvent.click(screen.getByRole('button', { name: /generate message/i }));
    expect(messageBox()).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /^rotate$/i }));
    await waitFor(() => expect(messageBox()).toBeNull());
  });
});
