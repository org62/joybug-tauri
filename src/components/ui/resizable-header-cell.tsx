import { cn } from "@/lib/utils";

/**
 * Fixed-width column-header cell with a right-edge resize grip. Pairs with
 * `useColumnWidths`: pass `handleColumnResizeStart(key, e)` as `onResizeStart`.
 * The `pr-1` keeps the label clear of the grip; row cells mirror it so column
 * content aligns with the header.
 */
export function ResizableHeaderCell({
  width,
  onResizeStart,
  className,
  children,
}: {
  width: number;
  onResizeStart: (e: React.MouseEvent) => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span className={cn("shrink-0 truncate relative pr-1", className)} style={{ width }}>
      {children}
      <div
        className="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-ring/40 active:bg-ring/60"
        onMouseDown={onResizeStart}
      />
    </span>
  );
}
