import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * The panel half of `useHoverPopup`: a fixed-position card placed just past
 * the cursor and clamped into the viewport. `width`/`height` are the space to
 * reserve for the clamp (an over-estimate is fine — it only pulls the panel
 * further from the edge).
 */
export interface HoverPopupPanelProps extends React.HTMLAttributes<HTMLDivElement> {
  x: number;
  y: number;
  width?: number;
  height?: number;
}

export const HoverPopupPanel = React.forwardRef<HTMLDivElement, HoverPopupPanelProps>(
  ({ x, y, width = 420, height = 300, className, style, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        "fixed z-50 bg-popover border border-border rounded shadow-lg p-2 text-xs font-mono select-text",
        className,
      )}
      style={{
        left: Math.min(x + 12, window.innerWidth - width),
        top: Math.min(y + 12, window.innerHeight - height),
        ...style,
      }}
      {...props}
    />
  ),
);
HoverPopupPanel.displayName = "HoverPopupPanel";
