import { useCallback, useEffect, useRef, useState } from 'react';
import { clampRect, resizeRect, type CropHandle, type CropRect } from '../lib/faceCrop.js';

/**
 * CropEditor — drag to move, corner handles to resize, over the picked selfie.
 *
 * Works in DISPLAY pixels and converts once on commit, so the box tracks the
 * pointer exactly at any rendered size; the parent only ever sees source-image
 * coordinates. Pointer Events (not mouse/touch pairs) with capture, so a drag
 * that leaves the image — which is most of them, since you drag toward an edge
 * to reframe — keeps tracking instead of sticking.
 */

export interface CropEditorProps {
  /** Object URL of the image being cropped. */
  src: string;
  /** Natural pixel size of that image. */
  imgWidth: number;
  imgHeight: number;
  /** Starting rect, in source-image pixels. */
  initial: CropRect;
  onCancel: () => void;
  onConfirm: (rect: CropRect) => void;
  labels: {
    title: string;
    hint: string;
    confirm: string;
    cancel: string;
    region: string;
  };
}

const HANDLES: CropHandle[] = ['nw', 'ne', 'sw', 'se'];

interface Drag {
  pointerId: number;
  handle: CropHandle | 'move';
  startX: number;
  startY: number;
  origin: CropRect;
}

export function CropEditor({
  src,
  imgWidth,
  imgHeight,
  initial,
  onCancel,
  onConfirm,
  labels,
}: CropEditorProps): JSX.Element {
  const frameRef = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<CropRect>(() => clampRect(initial, imgWidth, imgHeight));
  const [drag, setDrag] = useState<Drag | null>(null);
  // Displayed width of the image; the scale factor between source and screen.
  const [displayW, setDisplayW] = useState(0);

  const scale = displayW > 0 ? displayW / imgWidth : 0;

  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const measure = (): void => setDisplayW(el.clientWidth);
    measure();
    // The frame is fluid, so a rotation or resize must not desync box from image.
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const onPointerDown = useCallback(
    (handle: CropHandle | 'move') => (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      (e.target as Element).setPointerCapture?.(e.pointerId);
      setDrag({ pointerId: e.pointerId, handle, startX: e.clientX, startY: e.clientY, origin: rect });
    },
    [rect],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!drag || drag.pointerId !== e.pointerId || scale <= 0) return;
      // Screen delta → source-image delta.
      const dx = (e.clientX - drag.startX) / scale;
      const dy = (e.clientY - drag.startY) / scale;
      const o = drag.origin;

      if (drag.handle === 'move') {
        setRect(clampRect({ ...o, x: o.x + dx, y: o.y + dy }, imgWidth, imgHeight));
        return;
      }
      setRect(resizeRect(o, drag.handle, dx, dy, imgWidth, imgHeight));
    },
    [drag, scale, imgWidth, imgHeight],
  );

  const endDrag = useCallback(() => setDrag(null), []);

  // Percentages, so the overlay stays glued to the image at any rendered size.
  const style = {
    left: `${(rect.x / imgWidth) * 100}%`,
    top: `${(rect.y / imgHeight) * 100}%`,
    width: `${(rect.width / imgWidth) * 100}%`,
    height: `${(rect.height / imgHeight) * 100}%`,
  };

  return (
    <div className="crop-editor">
      <p>
        <strong>{labels.title}</strong>
      </p>
      <p className="muted">{labels.hint}</p>
      <div
        className="crop-frame"
        ref={frameRef}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <img src={src} alt="" draggable={false} />
        <div
          className="crop-box"
          style={style}
          role="group"
          aria-label={labels.region}
          onPointerDown={onPointerDown('move')}
        >
          {HANDLES.map((h) => (
            <span
              key={h}
              className={`crop-handle crop-${h}`}
              onPointerDown={onPointerDown(h)}
              aria-hidden="true"
            />
          ))}
        </div>
      </div>
      <div className="quality-actions">
        <button className="btn btn-primary" onClick={() => onConfirm(rect)}>
          {labels.confirm}
        </button>
        <button className="btn btn-light" onClick={onCancel}>
          {labels.cancel}
        </button>
      </div>
    </div>
  );
}
