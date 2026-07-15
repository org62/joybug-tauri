import * as React from "react"
import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area"

import { cn } from "@/lib/utils"

// Radix wraps the viewport's children in an internal `display:table; min-width:100%`
// div, which shrink-wraps to the content's max-content width. In a vertical-only
// scroll area (no horizontal bar) that just pushes wide rows off the right edge
// unreachably, so force it to `block` to fill the viewport and let rows truncate.
// Horizontal/both keep table sizing so wide content can actually scroll.
const VERTICAL_CONTENT_FIX = "[&>div]:!block"

interface ScrollAreaProps extends React.ComponentProps<typeof ScrollAreaPrimitive.Root> {
  onScroll?: React.UIEventHandler<HTMLDivElement>;
  viewportRef?: React.Ref<HTMLDivElement>;
  /**
   * Which scrollbars to render. Defaults to "vertical". Use "both" for wide
   * tables that need horizontal scrolling (the primitive supports it but the
   * default never mounts a horizontal bar).
   */
  orientation?: "vertical" | "horizontal" | "both";
}

function ScrollArea({
  className,
  children,
  onScroll,
  viewportRef,
  orientation = "vertical",
  ...props
}: ScrollAreaProps) {
  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      className={cn("relative", className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        ref={viewportRef}
        data-slot="scroll-area-viewport"
        className={cn(
          // max-h-[inherit]: a `max-h-*` on the root must constrain the viewport
          // (its percentage height can't resolve against an auto-height root, so
          // without this the content spills past the root unclipped and never
          // scrolls). Roots without max-height inherit `none` — a no-op.
          "focus-visible:ring-ring/50 size-full max-h-[inherit] rounded-[inherit] transition-[color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:outline-1",
          orientation === "vertical" && VERTICAL_CONTENT_FIX
        )}
        onScroll={onScroll}
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      {(orientation === "vertical" || orientation === "both") && <ScrollBar />}
      {(orientation === "horizontal" || orientation === "both") && (
        <ScrollBar orientation="horizontal" />
      )}
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  )
}

function ScrollBar({
  className,
  orientation = "vertical",
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>) {
  return (
    <ScrollAreaPrimitive.ScrollAreaScrollbar
      data-slot="scroll-area-scrollbar"
      orientation={orientation}
      className={cn(
        "flex touch-none p-px transition-colors select-none",
        orientation === "vertical" &&
          "h-full w-2.5 border-l border-l-transparent",
        orientation === "horizontal" &&
          "h-2.5 flex-col border-t border-t-transparent",
        className
      )}
      {...props}
    >
      <ScrollAreaPrimitive.ScrollAreaThumb
        data-slot="scroll-area-thumb"
        className="bg-border relative flex-1 rounded-full"
      />
    </ScrollAreaPrimitive.ScrollAreaScrollbar>
  )
}

export { ScrollArea, ScrollBar }
