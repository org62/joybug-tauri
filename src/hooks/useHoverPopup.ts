import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * Delayed, interactive hover popup: the cursor must rest on a trigger for
 * `showDelay` before the popup appears, and leaving the trigger grants
 * `hideGrace` for the cursor to reach the popup itself — spread `popupProps`
 * on it — so its text stays selectable and copyable.
 *
 * The cursor position is tracked in a ref and snapshotted into state only when
 * the popup opens, so sweeping the mouse across triggers costs no renders.
 * `show`/`move`/`leave` keep stable identities, so memoized rows (the
 * disassembly listing) can take them as props without losing memoization.
 *
 * Pairs with `HoverPopupPanel` (`@/components/ui/hover-popup`), which does the
 * fixed positioning and viewport clamping.
 */
export interface HoverPopupState<T> {
  /** Payload of the open popup; null while hidden. */
  target: T | null;
  /** Viewport coordinates the popup opened at. */
  pos: { x: number; y: number };
  /** Trigger `onMouseEnter`: arms the show timer for `payload`. */
  show: (e: { clientX: number; clientY: number }, payload: T) => void;
  /** Trigger `onMouseMove`: tracks the cursor without re-rendering. */
  move: (e: { clientX: number; clientY: number }) => void;
  /** Trigger `onMouseLeave`: disarms, then hides after the grace period. */
  leave: () => void;
  /** Close now (also cancels a pending show). */
  dismiss: () => void;
  /** Spread on the popup element so hovering it keeps it open. */
  popupProps: { onMouseEnter: () => void; onMouseLeave: () => void };
}

export function useHoverPopup<T>(showDelay = 1000, hideGrace = 150): HoverPopupState<T> {
  const [target, setTarget] = useState<T | null>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const posRef = useRef({ x: 0, y: 0 });
  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const overPopup = useRef(false);

  useEffect(() => () => {
    if (showTimer.current) clearTimeout(showTimer.current);
    if (hideTimer.current) clearTimeout(hideTimer.current);
  }, []);

  const dismiss = useCallback(() => {
    setTarget(null);
    if (showTimer.current) { clearTimeout(showTimer.current); showTimer.current = null; }
  }, []);

  const move = useCallback((e: { clientX: number; clientY: number }) => {
    posRef.current = { x: e.clientX, y: e.clientY };
  }, []);

  const show = useCallback((e: { clientX: number; clientY: number }, payload: T) => {
    if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null; }
    posRef.current = { x: e.clientX, y: e.clientY };
    if (showTimer.current) clearTimeout(showTimer.current);
    showTimer.current = setTimeout(() => {
      setPos(posRef.current);
      setTarget(payload);
    }, showDelay);
  }, [showDelay]);

  const leave = useCallback(() => {
    if (showTimer.current) { clearTimeout(showTimer.current); showTimer.current = null; }
    hideTimer.current = setTimeout(() => {
      if (!overPopup.current) dismiss();
    }, hideGrace);
  }, [dismiss, hideGrace]);

  const popupProps = useMemo(() => ({
    onMouseEnter: () => {
      overPopup.current = true;
      if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null; }
    },
    onMouseLeave: () => {
      overPopup.current = false;
      dismiss();
    },
  }), [dismiss]);

  return { target, pos, show, move, leave, dismiss, popupProps };
}
