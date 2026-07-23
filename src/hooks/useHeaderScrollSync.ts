import { useCallback, useEffect, useRef } from 'react';

/**
 * Keeps a fixed column header horizontally aligned with a horizontally
 * scrolling list viewport. Render the header inside a `shrink-0
 * overflow-hidden` wrapper, put `headerInnerRef` (and the row min-width) on
 * the inner div, and wire `handleViewportScroll` to the scrolled viewport
 * (e.g. VirtualizedList's `onViewportScroll`) — or call `syncScrollLeft`
 * from a handler that also does other scroll work.
 *
 * Pass the same `rowMinWidth` the rows use: when it changes (column resize),
 * the viewport can clamp or reset its horizontal scroll without firing a
 * scroll event, so the header is re-aligned from `getViewport`'s current
 * scrollLeft (or back to 0 when no viewport getter is supplied).
 */
export function useHeaderScrollSync(
  rowMinWidth: string,
  getViewport?: () => HTMLElement | null | undefined,
) {
  const headerInnerRef = useRef<HTMLDivElement>(null);
  const lastScrollLeft = useRef(0);

  const syncScrollLeft = useCallback((scrollLeft: number) => {
    if (scrollLeft === lastScrollLeft.current) return;
    lastScrollLeft.current = scrollLeft;
    if (headerInnerRef.current) {
      headerInnerRef.current.style.transform = `translateX(-${scrollLeft}px)`;
    }
  }, []);

  const handleViewportScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    syncScrollLeft(e.currentTarget.scrollLeft);
  }, [syncScrollLeft]);

  const getViewportRef = useRef(getViewport);
  getViewportRef.current = getViewport;
  useEffect(() => {
    const scrollLeft = getViewportRef.current?.()?.scrollLeft ?? 0;
    lastScrollLeft.current = scrollLeft;
    if (headerInnerRef.current) {
      headerInnerRef.current.style.transform = `translateX(-${scrollLeft}px)`;
    }
  }, [rowMinWidth]);

  return { headerInnerRef, handleViewportScroll, syncScrollLeft };
}
