import { describe, it, expect, vi } from 'vitest';
import { savePhotosIndividually, type NamedBlob } from './downloads.js';

function items(n: number): NamedBlob[] {
  return Array.from({ length: n }, (_, i) => ({
    blob: new Blob([`img-${i}`], { type: 'image/jpeg' }),
    filename: `IMG_${i}.jpg`,
  }));
}

/** A document stub that records anchor download clicks. */
function fakeDoc(): { doc: Document; clicks: string[] } {
  const clicks: string[] = [];
  const doc = {
    createElement: () => {
      const a: Record<string, unknown> = {
        click() {
          clicks.push(String(a.download));
        },
        remove() {},
      };
      return a as unknown as HTMLAnchorElement;
    },
    body: { appendChild() {} },
  } as unknown as Document;
  return { doc, clicks };
}

describe('savePhotosIndividually', () => {
  it('shares all files at once when the browser supports it', async () => {
    const share = vi.fn((_data: ShareData) => Promise.resolve());
    const nav = {
      share,
      canShare: () => true,
    } as unknown as Navigator;

    const outcome = await savePhotosIndividually(items(3), { title: 'Photos' }, { nav });

    expect(outcome).toBe('shared');
    expect(share).toHaveBeenCalledTimes(1);
    const shared = share.mock.calls[0]![0] as { files: File[] };
    expect(shared.files).toHaveLength(3);
  });

  it('downloads each file when sharing is unsupported', async () => {
    const nav = {} as Navigator; // no share/canShare
    const { doc, clicks } = fakeDoc();
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:x');
    globalThis.URL.revokeObjectURL = vi.fn();

    const outcome = await savePhotosIndividually(items(2), {}, { nav, doc });

    expect(outcome).toBe('unsupported');
    expect(clicks).toEqual(['IMG_0.jpg', 'IMG_1.jpg']);
  });

  it('returns cancelled (no downloads) when the user dismisses the share sheet', async () => {
    const share = vi.fn(async () => {
      throw new DOMException('user cancelled', 'AbortError');
    });
    const nav = { share, canShare: () => true } as unknown as Navigator;
    const { doc, clicks } = fakeDoc();

    const outcome = await savePhotosIndividually(items(2), {}, { nav, doc });

    expect(outcome).toBe('cancelled');
    expect(clicks).toEqual([]);
  });

  it('is a no-op for an empty selection', async () => {
    const outcome = await savePhotosIndividually([], {}, { nav: {} as Navigator });
    expect(outcome).toBe('unsupported');
  });
});
