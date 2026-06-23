import { useEffect, useRef, type ReactNode } from 'react';

/**
 * Lightbox — full-size photo viewer with prev/next navigation (dev plan §5B C4).
 *
 * Find Me results are tiny thumbnails; you can't tell whether a match is
 * actually you without seeing the photo bigger. This overlays the larger
 * derivative (`webUrl`), lets you page through the result set (on-screen
 * arrows, ← / → keys, and touch swipe), and renders per-photo actions
 * (Select / Not me / That's me) in a footer so verification and the decision
 * happen in one place. Esc or a backdrop tap closes.
 */

export interface LightboxItem {
  /** Stable key (photoId). */
  key: string;
  /** Full-size image URL. On mobile this is the original (full-resolution)
   *  object URL; elsewhere the `web` derivative. */
  src: string;
  /** Optional smaller URL to fall back to if `src` fails to decode (e.g. a HEIC
   *  original on a browser that can't render it → use the JPEG `web`/thumb). */
  fallbackSrc?: string;
  alt?: string;
  /** Optional overlay (e.g. the match-confidence band chip). */
  badge?: ReactNode;
}

interface LightboxProps {
  items: readonly LightboxItem[];
  index: number;
  onClose: () => void;
  onNavigate: (nextIndex: number) => void;
  /** Per-photo controls rendered under the image (select / feedback). */
  renderFooter?: (item: LightboxItem, index: number) => ReactNode;
}

export function Lightbox({
  items,
  index,
  onClose,
  onNavigate,
  renderFooter,
}: LightboxProps): JSX.Element | null {
  const touchX = useRef<number | null>(null);
  const item = items[index];
  const hasPrev = index > 0;
  const hasNext = index < items.length - 1;

  // Keyboard: Esc closes, arrows page. Bound while the lightbox is open.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft' && hasPrev) onNavigate(index - 1);
      else if (e.key === 'ArrowRight' && hasNext) onNavigate(index + 1);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, hasPrev, hasNext, onClose, onNavigate]);

  if (!item) return null;

  function onTouchEnd(e: React.TouchEvent): void {
    const start = touchX.current;
    const touch = e.changedTouches[0];
    touchX.current = null;
    if (start === null || !touch) return;
    const dx = touch.clientX - start;
    if (Math.abs(dx) < 40) return; // ignore taps / tiny drags
    if (dx > 0 && hasPrev) onNavigate(index - 1);
    else if (dx < 0 && hasNext) onNavigate(index + 1);
  }

  return (
    <div className="lightbox" role="dialog" aria-modal="true" onClick={onClose}>
      <button className="lightbox-close" aria-label="Close" onClick={onClose}>
        ✕
      </button>
      <div className="lightbox-stage" onClick={(e) => e.stopPropagation()}>
        {hasPrev && (
          <button
            className="lightbox-nav lightbox-prev"
            aria-label="Previous photo"
            onClick={() => onNavigate(index - 1)}
          >
            ‹
          </button>
        )}
        <img
          key={item.key}
          src={item.src}
          alt={item.alt ?? ''}
          onError={(e) => {
            // Original failed to decode (e.g. HEIC on a non-Safari browser):
            // fall back to the JPEG derivative once, guarding against a loop.
            const img = e.currentTarget;
            if (item.fallbackSrc && img.src !== item.fallbackSrc) {
              img.src = item.fallbackSrc;
            }
          }}
          onTouchStart={(e) => {
            touchX.current = e.touches[0]?.clientX ?? null;
          }}
          onTouchEnd={onTouchEnd}
        />
        {item.badge && <div className="lightbox-badge">{item.badge}</div>}
        {hasNext && (
          <button
            className="lightbox-nav lightbox-next"
            aria-label="Next photo"
            onClick={() => onNavigate(index + 1)}
          >
            ›
          </button>
        )}
      </div>
      <div className="lightbox-bar" onClick={(e) => e.stopPropagation()}>
        <span className="lightbox-count">
          {index + 1} / {items.length}
        </span>
        {renderFooter && <div className="lightbox-actions">{renderFooter(item, index)}</div>}
      </div>
    </div>
  );
}
