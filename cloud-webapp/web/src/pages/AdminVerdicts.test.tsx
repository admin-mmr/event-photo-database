import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../lib/firebase.js', () => ({
  idToken: async () => 'fake-token',
}));

const { AdminVerdicts } = await import('./AdminVerdicts.js');

const LIST = {
  ok: true,
  total: 2,
  unattributed: 1,
  capped: false,
  batches: [
    {
      runId: 'run-1',
      eventId: 'ev1',
      uid: 'u1',
      email: 'runner@mmrunners.org',
      name: 'Jamie Lee',
      markedAt: '2026-06-15T10:02:00.000Z',
      searchedAt: '2026-06-15T09:55:00.000Z',
      mode: 'fused',
      modelVersion: 'm-1',
      searchVersion: 'v3',
      algo: { version: 'v3', tnorm: false, prf: true, prfCount: 2, numReferences: 1 },
      resultCount: 5,
      selfieUrl: 'https://signed.example/selfie-1',
      selfieUploadId: 'up-1',
      counts: { not_me: 2, confirmed: 1 },
      total: 3,
    },
    {
      runId: 'run-2',
      eventId: 'ev2',
      uid: 'u2',
      email: null,
      name: null,
      markedAt: '2026-06-14T10:00:00.000Z',
      searchedAt: null,
      mode: null,
      modelVersion: null,
      searchVersion: null,
      algo: null,
      resultCount: null,
      // No selfie: expired, erased, or a run that predates selfie linking.
      selfieUrl: null,
      selfieUploadId: null,
      counts: { not_me: 1, confirmed: 0 },
      total: 1,
    },
  ],
};

const DETAIL = {
  ok: true,
  batch: {
    ...LIST.batches[0],
    votes: [
      {
        feedbackId: 'f2',
        photoId: 'pB',
        verdict: 'confirmed',
        createdAt: '2026-06-15T10:01:00.000Z',
        thumbUrl: 't/ev1/pB',
        score: 0.93,
        rank: 1,
      },
      {
        feedbackId: 'f1',
        photoId: 'pA',
        verdict: 'not_me',
        createdAt: '2026-06-15T10:00:00.000Z',
        thumbUrl: 't/ev1/pA',
        score: 0.71,
        rank: 3,
      },
    ],
  },
};

/** Route fetches by URL so the list and the batch detail can both resolve. */
function mockRoutes(byPath: Array<[RegExp, number, unknown]>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const hit = byPath.find(([re]) => re.test(url));
      const [, status, body] = hit ?? [null, 404, { error: 'not_found', message: 'no route' }];
      return new Response(JSON.stringify(body), {
        status: status as number,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
}

function renderPage(): void {
  render(
    <MemoryRouter>
      <AdminVerdicts />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('<AdminVerdicts />', () => {
  it('lists batches with their selfie, searcher and tallies', async () => {
    mockRoutes([[/\/api\/admin\/verdict-batches$/, 200, LIST]]);
    renderPage();

    await waitFor(() => expect(screen.getByText('Jamie Lee')).toBeTruthy());
    expect(screen.getByText(/2 batches/)).toBeTruthy();
    expect(screen.getByText(/1 not linked to a search/)).toBeTruthy();
    expect(screen.getByText(/1 that's me/)).toBeTruthy();
    expect(screen.getByText(/3 of 5 results judged/)).toBeTruthy();
    // A batch with no name/email falls back to the guest label, and its
    // verdict count is shown without a result total.
    expect(screen.getByText('Guest')).toBeTruthy();
    expect(screen.getByText(/1 verdict$/)).toBeTruthy();
    // The signed selfie renders; the missing one degrades to a placeholder.
    const selfies = screen.getAllByAltText('Selfie searched with');
    expect(selfies).toHaveLength(1);
    expect(selfies[0]!.getAttribute('src')).toBe('https://signed.example/selfie-1');
  });

  it('opens a batch and shows every verdict with its rank and score', async () => {
    mockRoutes([
      [/\/api\/admin\/verdict-batches\/run-1$/, 200, DETAIL],
      [/\/api\/admin\/verdict-batches$/, 200, LIST],
    ]);
    renderPage();

    await waitFor(() => expect(screen.getByText('Jamie Lee')).toBeTruthy());
    fireEvent.click(screen.getAllByRole('button', { name: 'View verdicts' })[0]!);

    await waitFor(() => expect(screen.getByText('fused')).toBeTruthy());
    // Both verdicts rendered, with the matcher's rank + score for each photo.
    expect(screen.getByAltText('pB')).toBeTruthy();
    expect(screen.getByAltText('pA')).toBeTruthy();
    expect(screen.getByText(/#1 0\.93/)).toBeTruthy();
    expect(screen.getByText(/#3 0\.71/)).toBeTruthy();
    expect(screen.getByText('v3 +prf(2)')).toBeTruthy();
    const grid = within(screen.getByRole('list'));
    expect(grid.getByText("That's me")).toBeTruthy();
    expect(grid.getByText('Wrong match')).toBeTruthy();
  });

  it('shows an admin-only message on 403', async () => {
    mockRoutes([[/verdict-batches/, 403, { error: 'forbidden', message: 'admin only' }]]);
    renderPage();
    await waitFor(() => expect(screen.getByText(/admin-only/i)).toBeTruthy());
  });

  it('shows an empty state when nothing has been judged', async () => {
    mockRoutes([
      [/verdict-batches/, 200, { ok: true, total: 0, unattributed: 0, capped: false, batches: [] }],
    ]);
    renderPage();
    await waitFor(() => expect(screen.getByText(/No verdict batches yet/i)).toBeTruthy());
  });
});
