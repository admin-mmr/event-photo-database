/**
 * <VolunteerUpload /> — the photographer-name field remembers itself.
 *
 * WHY THIS MATTERS: the field used to start blank on every visit, so a volunteer
 * uploading across several sessions typed their name once and was credited once.
 * On the 2026 NYRR event that put 408 photos into `..._volunteer` folders instead
 * of a person's name — the credit is baked into the stored filename, so it is not
 * recoverable after the fact.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

vi.mock('../lib/firebase.js', () => ({ idToken: async () => 'fake-token' }));

// Uploads are driven per test; the real module would talk to GCS.
const uploadFileResumable = vi.fn();
vi.mock('../lib/resumableUpload.js', () => ({
  uploadFileResumable: (...args: unknown[]) => uploadFileResumable(...args),
  AbortError: class AbortError extends Error {},
}));
const apiPost = vi.fn(async () => ({ ok: true, message: 'ok' }));
vi.mock('../lib/api.js', () => ({
  apiGet: vi.fn(async () => ({ ok: true })),
  apiPost: (...args: unknown[]) => apiPost(...(args as [])),
}));

const { VolunteerUpload } = await import('./VolunteerUpload.js');

const KEY = 'findme.photographerName';

function renderPage(): void {
  render(
    <MemoryRouter initialEntries={['/upload/tok-1']}>
      <Routes>
        <Route path="/upload/:token" element={<VolunteerUpload />} />
      </Routes>
    </MemoryRouter>,
  );
}

const nameInput = (): HTMLInputElement => screen.getByLabelText(/your name/i) as HTMLInputElement;

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('<VolunteerUpload /> photographer name', () => {
  it('starts blank for a first-time uploader', () => {
    renderPage();
    expect(nameInput().value).toBe('');
  });

  it('prefills the name remembered from a previous session', () => {
    window.localStorage.setItem(KEY, 'Rebecca Tan');
    renderPage();
    expect(nameInput().value).toBe('Rebecca Tan');
  });

  it('remembers what the volunteer types', () => {
    renderPage();
    fireEvent.change(nameInput(), { target: { value: 'Liyi Guo' } });
    expect(window.localStorage.getItem(KEY)).toBe('Liyi Guo');
  });

  it('stores the trimmed name, since it becomes part of the filename', () => {
    renderPage();
    fireEvent.change(nameInput(), { target: { value: '  Haiying  ' } });
    expect(window.localStorage.getItem(KEY)).toBe('Haiying');
  });

  it('forgets the name when the field is cleared — an opt-out on a shared device', () => {
    window.localStorage.setItem(KEY, 'Rebecca Tan');
    renderPage();
    fireEvent.change(nameInput(), { target: { value: '' } });
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it('still renders when storage is unavailable (Safari private mode throws)', () => {
    // Losing the prefill is acceptable; breaking the upload page is not.
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('SecurityError');
      },
      removeItem: () => {
        throw new Error('SecurityError');
      },
      clear: () => undefined,
    });
    renderPage();
    expect(nameInput().value).toBe('');
    // And typing must not throw either.
    expect(() => fireEvent.change(nameInput(), { target: { value: 'Jane' } })).not.toThrow();
    expect(nameInput().value).toBe('Jane');
  });
});

// 2026-11-03: an iPhone session staged 17 photos and never sent /complete —
// iOS froze the page on an app switch without firing `pagehide`, so they sat in
// staging ~2h until the hourly sweep. Going hidden now sends what is done.
describe('<VolunteerUpload /> page hidden mid-upload', () => {
  function setVisibility(state: 'hidden' | 'visible'): void {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
    document.dispatchEvent(new Event('visibilitychange'));
  }

  afterEach(() => {
    setVisibility('visible');
    uploadFileResumable.mockReset();
  });

  it('beacons the finished files to /complete when the page goes hidden', async () => {
    const sendBeacon = vi.fn(() => true);
    vi.stubGlobal('navigator', { ...navigator, sendBeacon });
    uploadFileResumable
      .mockResolvedValueOnce({ uploadId: 'up-1', objectName: 'vol/ev/b/1.jpg', bytes: 3 })
      .mockReturnValue(new Promise(() => undefined)); // the second is still uploading
    const { container } = render(
      <MemoryRouter initialEntries={['/upload/tok-1']}>
        <Routes>
          <Route path="/upload/:token" element={<VolunteerUpload />} />
        </Routes>
      </MemoryRouter>,
    );
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const files = [
      new File(['abc'], '1.jpg', { type: 'image/jpeg' }),
      new File(['def'], '2.jpg', { type: 'image/jpeg' }),
    ];
    fireEvent.change(input, { target: { files } });
    await waitFor(() => expect(uploadFileResumable).toHaveBeenCalledTimes(2));

    setVisibility('hidden');
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    const [url, blob] = sendBeacon.mock.calls[0] as unknown as [string, Blob];
    expect(url).toBe('/api/volunteer/upload/complete');
    const text = await new Promise<string>((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.readAsText(blob);
    });
    const body = JSON.parse(text) as { items: Array<{ objectName: string }> };
    expect(body.items.map((i) => i.objectName)).toEqual(['vol/ev/b/1.jpg']);

    // Coming back and hiding again does not re-send what already went.
    setVisibility('visible');
    setVisibility('hidden');
    expect(sendBeacon).toHaveBeenCalledTimes(1);
  });
});

