import React, { useLayoutEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

// Virtualized rows rendered inline within an outer ScrollArea (rather than in
// their own scroll region): measures the list's offset from the scroll
// container so the virtualizer's scrollMargin stays correct as content above
// the list changes size. Shared by ModuleInfoView's tables and the PE
// structure tree's imports/exports/exception groups.
export function useInlineVirtualizer(
  scrollContainerRef: React.RefObject<HTMLDivElement | null>,
  count: number,
  rowHeight: number,
) {
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);

  // Deliberately no dependency array: content above the list can change size
  // without this component re-rendering with new props (e.g. a sibling group
  // collapsing), so the margin is re-measured on every render — the scroll
  // re-renders the virtualizer triggers keep it self-healing. setState with an
  // unchanged value bails out, so steady-state renders don't loop.
  useLayoutEffect(() => {
    if (listRef.current && scrollContainerRef.current) {
      const listTop = listRef.current.getBoundingClientRect().top;
      const scrollTop = scrollContainerRef.current.getBoundingClientRect().top;
      setScrollMargin(listTop - scrollTop + scrollContainerRef.current.scrollTop);
    }
  });

  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => rowHeight,
    overscan: 30,
    scrollMargin,
  });

  const rowStyle = (virtualRow: { start: number }): React.CSSProperties => ({
    position: 'absolute',
    top: virtualRow.start - virtualizer.options.scrollMargin,
    left: 0,
    right: 0,
    height: rowHeight,
  });

  return { listRef, virtualizer, rowStyle };
}
