import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { App } from './App.js';

// Mock fetch so we don't hit the real api in tests.
beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/health') {
        return new Response(
          JSON.stringify({ ok: true, version: '0.1.0', uptimeSec: 1, commit: null }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 404 });
    }),
  );
});

describe('<App />', () => {
  it('renders and surfaces the api health payload', async () => {
    render(<App />);
    expect(screen.getByText(/Event Photo Database/i)).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByText(/"version": "0.1.0"/)).toBeTruthy();
    });
  });
});
