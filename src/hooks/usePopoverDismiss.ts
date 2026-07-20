import { useEffect, RefObject } from 'react';

/**
 * Placement for a dropdown portaled to <body> under an anchor element:
 * left/top/width follow the anchor, maxHeight clamps to the viewport.
 */
export interface AnchoredDropdownRect {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
}

export function computeAnchoredDropdownRect(anchor: HTMLElement): AnchoredDropdownRect {
  const r = anchor.getBoundingClientRect();
  return {
    left: r.left,
    top: r.bottom + 4,
    width: r.width,
    maxHeight: Math.max(96, Math.min(256, window.innerHeight - r.bottom - 12)),
  };
}

/**
 * Dismissal wiring for a portaled popover anchored to a trigger: closes on a
 * mousedown outside both the anchor and the popover, and on Escape. Shared by
 * the PE address popover and the TypesView results dropdown.
 */
export function usePopoverDismiss(
  open: boolean,
  onClose: () => void,
  anchorRef: RefObject<HTMLElement | null>,
  popoverRef: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (anchorRef.current?.contains(e.target as Node)) return;
      if (popoverRef.current?.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose, anchorRef, popoverRef]);
}
