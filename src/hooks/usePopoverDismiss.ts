import { useEffect, RefObject } from 'react';

/**
 * Placement for a dropdown portaled to <body> under (or above) an anchor
 * element: left/width follow the anchor, maxHeight clamps to the viewport.
 * Exactly one of top/bottom is set: `top` anchors the dropdown below the
 * anchor, `bottom` pins its lower edge just above the anchor (so a
 * shorter-than-max dropdown still touches the anchor when flipped).
 */
export interface AnchoredDropdownRect {
  left: number;
  width: number;
  maxHeight: number;
  top?: number;
  bottom?: number;
}

export interface AnchoredDropdownOptions {
  /** Floor for the dropdown width (the anchor may be narrower). */
  minWidth?: number;
  /** Ceiling for maxHeight (default 256). */
  maxHeightCap?: number;
  /** Open above the anchor when below can't fit a useful dropdown but above can. */
  flip?: boolean;
}

export function computeAnchoredDropdownRect(
  anchor: HTMLElement,
  opts: AnchoredDropdownOptions = {},
): AnchoredDropdownRect {
  const { minWidth = 0, maxHeightCap = 256, flip = false } = opts;
  const r = anchor.getBoundingClientRect();
  const width = Math.max(r.width, minWidth);
  const left = Math.max(4, Math.min(r.left, window.innerWidth - width - 4));
  const below = window.innerHeight - r.bottom - 12;
  const above = r.top - 12;
  const openAbove = flip && below < Math.min(maxHeightCap, 160) && above > below;
  const maxHeight = Math.max(96, Math.min(maxHeightCap, openAbove ? above : below));
  return openAbove
    ? { left, width, maxHeight, bottom: window.innerHeight - r.top + 4 }
    : { left, width, maxHeight, top: r.bottom + 4 };
}

/**
 * Dismissal wiring for a portaled popover anchored to a trigger: closes on a
 * mousedown outside both the anchor and the popover, and on Escape. Shared by
 * the PE address popover, the TypesView results dropdown, HistoryInput, and
 * VirtualCombobox.
 *
 * `captureEscape` handles Escape on the document capture phase and consumes
 * it, so hosts that treat Escape as "close" (dialogs, the assemble editor)
 * only see it when no popover is open. (A Radix dialog's own capture listener
 * registers at dialog mount, i.e. earlier — DialogContent additionally guards
 * via open-dropdown checks, see dialog.tsx.)
 */
export function usePopoverDismiss(
  open: boolean,
  onClose: () => void,
  anchorRef: RefObject<HTMLElement | null>,
  popoverRef: RefObject<HTMLElement | null>,
  opts?: { captureEscape?: boolean },
) {
  const captureEscape = opts?.captureEscape ?? false;
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (anchorRef.current?.contains(e.target as Node)) return;
      if (popoverRef.current?.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (captureEscape) e.stopPropagation();
      onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, captureEscape);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, captureEscape);
    };
  }, [open, onClose, anchorRef, popoverRef, captureEscape]);
}
