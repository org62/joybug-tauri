import { useRef, useImperativeHandle } from "react";
import { useVirtualizer, Virtualizer } from "@tanstack/react-virtual";
import { ScrollArea } from "./scroll-area";

interface VirtualizedListProps<T> {
  items: T[];
  rowHeight: number;
  renderItem: (item: T, index: number) => React.ReactNode;
  overscan?: number;
  className?: string;
  style?: React.CSSProperties;
  getItemKey?: (item: T, index: number) => React.Key;
  virtualizerRef?: React.Ref<Virtualizer<HTMLDivElement, Element>>;
}

function VirtualizedListInner<T>({
  items,
  rowHeight,
  renderItem,
  overscan = 20,
  className,
  style,
  getItemKey,
  virtualizerRef,
}: VirtualizedListProps<T>) {
  const viewportRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => viewportRef.current,
    estimateSize: () => rowHeight,
    overscan,
  });

  useImperativeHandle(virtualizerRef, () => virtualizer, [virtualizer]);

  if (items.length === 0) {
    return <ScrollArea className={className} style={style} />;
  }

  return (
    <ScrollArea className={className} style={style} viewportRef={viewportRef}>
      <div
        style={{
          height: virtualizer.getTotalSize(),
          width: "100%",
          position: "relative",
        }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const item = items[virtualRow.index];
          const key = getItemKey
            ? getItemKey(item, virtualRow.index)
            : virtualRow.key;
          return (
            <div
              key={key}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                height: virtualRow.size,
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              {renderItem(item, virtualRow.index)}
            </div>
          );
        })}
      </div>
    </ScrollArea>
  );
}

export { VirtualizedListInner as VirtualizedList };
export type { VirtualizedListProps };
