import * as React from "react"

import { cn } from "@/lib/utils"
import { ScrollArea } from "@/components/ui/scroll-area"

/**
 * Layout primitives for rc-dock tab views.
 *
 * Every dock view MUST be a `<DockPanel>` at its root. The dock wrapper
 * (DockingLayout `enhancedLoadTab`) puts each tab inside
 * `<div className="absolute inset-0"><ScrollArea>`, so a view root of
 * `absolute inset-0` takes itself out of flow — the outer ScrollArea becomes
 * inert and the view controls its own scroll, keeping the toolbar fixed. A
 * plain `h-full` root instead collapses against Radix's auto-height viewport
 * and makes the whole panel (toolbar included) scroll. `<DockPanel>` encodes
 * the correct root so no view has to remember this.
 *
 *   <DockPanel>
 *     <PanelToolbar> ...buttons... </PanelToolbar>
 *     <PanelBody> ...scrollable content... </PanelBody>
 *   </DockPanel>
 */
const DockPanel = React.forwardRef<HTMLDivElement, React.ComponentProps<"div">>(
  ({ className, ...props }, ref) => {
    return (
      <div
        ref={ref}
        data-slot="dock-panel"
        className={cn(
          "absolute inset-0 flex flex-col overflow-hidden",
          className
        )}
        {...props}
      />
    )
  }
)
DockPanel.displayName = "DockPanel"

/**
 * Fixed toolbar/header row. Chrome — not text-selectable.
 * `stack` switches to a multi-row column layout (form-style headers) while
 * keeping the same padding/background contract as the single-row toolbar.
 *
 * `overflow` picks what happens once children can't shrink any further (their
 * `min-w-*`/intrinsic floors): "scroll" scrolls the bar horizontally, "wrap"
 * wraps onto extra rows. Default (unset) lets fixed-width children clip, which
 * is fine for toolbars that always fit.
 */
function PanelToolbar({
  className,
  stack,
  overflow,
  ...props
}: React.ComponentProps<"div"> & { stack?: boolean; overflow?: "scroll" | "wrap" }) {
  return (
    <div
      data-slot="panel-toolbar"
      className={cn(
        "shrink-0 flex gap-1 px-2 py-1 border-b border-border bg-muted/30 select-none",
        stack ? "flex-col" : "items-center",
        overflow === "scroll" && "overflow-x-auto scroll-area-thin",
        overflow === "wrap" && "flex-wrap",
        className
      )}
      {...props}
    />
  )
}

type PanelBodyProps = React.ComponentProps<typeof ScrollArea> & {
  /**
   * Floor for the content width; the body scrolls horizontally below it
   * instead of crushing the content (same contract as VirtualizedList's
   * prop of the same name). Implies orientation "both" unless overridden.
   */
  minContentWidth?: string
}

/**
 * Scrollable content region. Fills the remaining panel height and scrolls only
 * its own content. Forwards `viewportRef`/`onScroll`/`orientation` to the
 * underlying ScrollArea (needed by virtualized views).
 */
function PanelBody({ className, children, minContentWidth, orientation, ...props }: PanelBodyProps) {
  return (
    <ScrollArea
      data-slot="panel-body"
      className={cn("flex-1 min-h-0", className)}
      orientation={orientation ?? (minContentWidth ? "both" : undefined)}
      {...props}
    >
      {minContentWidth
        ? <div style={{ width: "100%", minWidth: minContentWidth }}>{children}</div>
        : children}
    </ScrollArea>
  )
}

/** Fixed footer bar (e.g. pagination controls). */
function PanelFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="panel-footer"
      className={cn(
        "shrink-0 flex items-center gap-1 px-2 py-1 border-t border-border bg-muted/30 select-none",
        className
      )}
      {...props}
    />
  )
}

export { DockPanel, PanelToolbar, PanelBody, PanelFooter }
