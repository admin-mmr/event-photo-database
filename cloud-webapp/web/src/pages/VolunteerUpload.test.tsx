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
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

vi.mock('../lib/firebase.js', () => ({ idToken: async () => 'fake-token' }));

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
