import { describe, it, expect, vi, beforeAll } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { CropEditor } from './CropEditor.js';
import type { CropRect } from '../lib/faceCrop.js';

/**
 * The geometry is unit-tested in faceCrop.test.ts; what this covers is the
 * WIRING — that a pointer drag in screen pixels is converted through the
 * display scale into source-image pixels. Getting that conversion wrong is
 * invisible to the pure tests and makes the box drift under the finger on
 * exactly the large photos this feature exists for.
 */

const IMG_W = 2000;
const IMG_H = 3000;
const DISPLAY_W = 400; // → scale 0.2, so 1 screen px = 5 source px

beforeAll(() => {
  // jsdom does no layout: without a width the editor can't compute a scale.
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() {
      return this.classList?.contains('crop-frame') ? DISPLAY_W : 0;
    },
  });
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe() {}
      disconnect() {}
    };
  }
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = () => undefined;
  }
  // jsdom has no PointerEvent; React's pointer handlers only need a MouseEvent
  // carrying a pointerId.
  if (!('PointerEvent' in globalThis)) {
    class FakePointerEvent extends MouseEvent {
      pointerId: number;
      constructor(type: string, init: MouseEventInit & { pointerId?: number } = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 0;
      }
    }
    (globalThis as { PointerEvent?: unknown }).PointerEvent = FakePointerEvent;
  }
});

const LABELS = {
  title: 'Adjust the crop',
  hint: 'Drag to move',
  confirm: 'Use this',
  cancel: 'Cancel',
  region: 'Crop area',
};

function setup(onConfirm = vi.fn()) {
  const initial = { x: 500, y: 600, width: 800, height: 1000 };
  render(
    <CropEditor
      src="blob:selfie"
      imgWidth={IMG_W}
      imgHeight={IMG_H}
      initial={initial}
      onCancel={vi.fn()}
      onConfirm={onConfirm}
      labels={LABELS}
    />,
  );
  return { onConfirm, initial };
}

/** One press-drag-release on `el`, in screen pixels. */
function drag(el: Element, fromX: number, fromY: number, toX: number, toY: number): void {
  const opts = { bubbles: true, pointerId: 1 };
  // Each step in its own act(): the pointerdown sets the drag state the
  // pointermove reads, so without a flush between them the move is a no-op.
  act(() => {
    el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, clientX: fromX, clientY: fromY }));
  });
  act(() => {
    el.dispatchEvent(new PointerEvent('pointermove', { ...opts, clientX: toX, clientY: toY }));
  });
  act(() => {
    el.dispatchEvent(new PointerEvent('pointerup', { ...opts, clientX: toX, clientY: toY }));
  });
}

describe('<CropEditor />', () => {
  it('converts a screen drag into source pixels at the display scale', () => {
    const { onConfirm, initial } = setup();
    const box = screen.getByRole('group', { name: 'Crop area' });
    // 20 screen px right, 10 down → 100 and 50 source px at scale 0.2.
    drag(box, 0, 0, 20, 10);
    act(() => screen.getByRole('button', { name: 'Use this' }).click());
    expect(onConfirm).toHaveBeenCalledWith({
      x: initial.x + 100,
      y: initial.y + 50,
      width: initial.width,
      height: initial.height,
    });
  });

  it('keeps a drag toward the edge inside the image', () => {
    const { onConfirm } = setup();
    const box = screen.getByRole('group', { name: 'Crop area' });
    drag(box, 0, 0, -200, -200);
    act(() => screen.getByRole('button', { name: 'Use this' }).click());
    const rect = onConfirm.mock.calls[0]![0] as CropRect;
    expect(rect.x).toBe(0);
    expect(rect.y).toBe(0);
  });

  it('confirms the untouched suggestion when nothing is dragged', () => {
    const { onConfirm, initial } = setup();
    act(() => screen.getByRole('button', { name: 'Use this' }).click());
    expect(onConfirm).toHaveBeenCalledWith(initial);
  });

  it('ignores pointer movement that is not part of a drag', () => {
    const { onConfirm, initial } = setup();
    const box = screen.getByRole('group', { name: 'Crop area' });
    box.dispatchEvent(
      new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientX: 80, clientY: 80 }),
    );
    act(() => screen.getByRole('button', { name: 'Use this' }).click());
    expect(onConfirm).toHaveBeenCalledWith(initial);
  });
});
