import { describe, it, expect, vi, beforeEach } from 'vitest';
import { canShareFiles, canShareImageFiles, shareFiles, saveToPhone } from './share.js';

function navWith(overrides: Partial<Navigator>): Navigator {
  return overrides as Navigator;
}

const file = new File([new Blob(['x'])], 'a.zip', { type: 'application/zip' });

describe('canShareFiles', () => {
  it('false when there are no files', () => {
    expect(canShareFiles([], navWith({ share: vi.fn(), canShare: () => true } as Partial<Navigator>))).toBe(false);
  });

  it('false when the browser lacks share/canShare', () => {
    expect(canShareFiles([file], navWith({}))).toBe(false);
  });

  it('true when canShare approves the files', () => {
    const nav = navWith({ share: vi.fn(), canShare: vi.fn().mockReturnValue(true) } as Partial<Navigator>);
    expect(canShareFiles([file], nav)).toBe(true);
  });

  it('false (not throw) when canShare throws', () => {
    const nav = navWith({
      share: vi.fn(),
      canShare: vi.fn(() => {
        throw new Error('boom');
      }),
    } as Partial<Navigator>);
    expect(canShareFiles([file], nav)).toBe(false);
  });
});

describe('canShareImageFiles', () => {
  it('true when the browser can share a probe JPEG (Web Share L2)', () => {
    const nav = navWith({ share: vi.fn(), canShare: vi.fn().mockReturnValue(true) } as Partial<Navigator>);
    expect(canShareImageFiles(nav)).toBe(true);
  });

  it('false when share exists but canShare rejects files (Web Share L1 only)', () => {
    const nav = navWith({ share: vi.fn(), canShare: vi.fn().mockReturnValue(false) } as Partial<Navigator>);
    expect(canShareImageFiles(nav)).toBe(false);
  });

  it('false when the browser lacks share/canShare (desktop)', () => {
    expect(canShareImageFiles(navWith({}))).toBe(false);
  });

  it('passes an image/jpeg file (not a zip) to canShare', () => {
    const canShare = vi.fn().mockReturnValue(true);
    const nav = navWith({ share: vi.fn(), canShare } as Partial<Navigator>);
    canShareImageFiles(nav);
    const arg = canShare.mock.calls[0]?.[0] as { files: File[] };
    expect(arg.files[0]?.type).toBe('image/jpeg');
  });
});

describe('shareFiles', () => {
  it('returns "unsupported" when files cannot be shared', async () => {
    expect(await shareFiles([file], {}, navWith({}))).toBe('unsupported');
  });

  it('returns "shared" when navigator.share resolves', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    const nav = navWith({ share, canShare: () => true } as Partial<Navigator>);
    expect(await shareFiles([file], { title: 'T' }, nav)).toBe('shared');
    expect(share).toHaveBeenCalledWith(expect.objectContaining({ files: [file], title: 'T' }));
  });

  it('returns "cancelled" when the user dismisses (AbortError)', async () => {
    const share = vi.fn().mockRejectedValue(new DOMException('x', 'AbortError'));
    const nav = navWith({ share, canShare: () => true } as Partial<Navigator>);
    expect(await shareFiles([file], {}, nav)).toBe('cancelled');
  });

  it('returns "error" on any other rejection', async () => {
    const share = vi.fn().mockRejectedValue(new Error('nope'));
    const nav = navWith({ share, canShare: () => true } as Partial<Navigator>);
    expect(await shareFiles([file], {}, nav)).toBe('error');
  });
});

describe('saveToPhone', () => {
  beforeEach(() => {
    // jsdom lacks createObjectURL/revokeObjectURL.
    Object.assign(URL, {
      createObjectURL: vi.fn().mockReturnValue('blob:x'),
      revokeObjectURL: vi.fn(),
    });
  });

  it('shares the blob when supported', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    const nav = navWith({ share, canShare: () => true } as Partial<Navigator>);
    const blob = new Blob(['zip'], { type: 'application/zip' });
    const outcome = await saveToPhone(blob, 'photos.zip', {}, { nav });
    expect(outcome).toBe('shared');
    expect(share).toHaveBeenCalledOnce();
  });

  it('falls back to a download when sharing is unsupported', async () => {
    const click = vi.fn();
    const anchor = { href: '', download: '', click, remove: vi.fn() } as unknown as HTMLAnchorElement;
    const doc = {
      createElement: vi.fn().mockReturnValue(anchor),
      body: { appendChild: vi.fn() },
    } as unknown as Document;
    const blob = new Blob(['zip'], { type: 'application/zip' });
    const outcome = await saveToPhone(blob, 'photos.zip', {}, { nav: navWith({}), doc });
    expect(outcome).toBe('unsupported');
    expect(click).toHaveBeenCalledOnce();
    expect(anchor.download).toBe('photos.zip');
  });
});
