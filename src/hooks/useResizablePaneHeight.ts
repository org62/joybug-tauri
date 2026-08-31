import { useCallback, useRef, useState } from "react";

/**
 * Height state for a drag-resizable bottom pane (quick-emulation strip, ETW
 * callstack detail): drag the handle up to grow, clamped between `minHeight`
 * and the parent's height minus `reserve` (room for the toolbar/list above).
 * The final height persists to localStorage on mouseup (not per mousemove).
 *
 * Attach `ref` to the pane root (its parent provides the max-height bound) and
 * `handleResizeStart` to the drag handle's `onMouseDown`.
 */
export function useResizablePaneHeight({
  storageKey,
  defaultHeight,
  minHeight,
  reserve,
}: {
  storageKey: string;
  defaultHeight: number;
  minHeight: number;
  /** Pixels of the parent to keep for the content above the pane. */
  reserve: number;
}) {
  const [height, setHeight] = useState(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored) {
        const n = parseInt(stored, 10);
        if (Number.isFinite(n)) return Math.max(minHeight, n);
      }
    } catch {
      /* localStorage unavailable */
    }
    return defaultHeight;
  });
  const ref = useRef<HTMLDivElement>(null);

  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startY = e.clientY;
      const startHeight = height;
      const parentHeight = ref.current?.parentElement?.clientHeight;
      const maxHeight = parentHeight ? parentHeight - reserve : 600;
      const onMouseMove = (ev: MouseEvent) => {
        // Dragging up (negative deltaY) grows the pane — it sits at the bottom.
        const delta = startY - ev.clientY;
        setHeight(Math.max(minHeight, Math.min(maxHeight, startHeight + delta)));
      };
      const onMouseUp = () => {
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        setHeight((h) => {
          try {
            localStorage.setItem(storageKey, String(h));
          } catch {
            /* localStorage unavailable */
          }
          return h;
        });
      };
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    },
    [height, minHeight, reserve, storageKey],
  );

  return { height, handleResizeStart, ref };
}
