import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Determinate progress bar. Hand-rolled rather than pulling in
 * `@radix-ui/react-progress` — this is two divs and a width, and the app has
 * exactly one use for it (the self-update download).
 *
 * Pass `value` as a 0-100 percentage. `indeterminate` covers the case where the
 * total isn't known yet; it animates instead of sitting at zero.
 */
function Progress({
  value,
  indeterminate = false,
  className,
  ...props
}: Omit<React.ComponentProps<"div">, "children"> & {
  value: number
  indeterminate?: boolean
}) {
  const clamped = Math.min(100, Math.max(0, Number.isFinite(value) ? value : 0))

  return (
    <div
      data-slot="progress"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      // An indeterminate bar reports no value, which is what tells a screen
      // reader "busy, duration unknown" rather than "stuck at 0%".
      aria-valuenow={indeterminate ? undefined : Math.round(clamped)}
      className={cn(
        "relative h-1.5 w-full overflow-hidden rounded-full bg-muted",
        className,
      )}
      {...props}
    >
      <div
        data-slot="progress-indicator"
        className={cn(
          "h-full rounded-full bg-primary transition-[width] duration-150 ease-out",
          indeterminate && "w-1/3 animate-pulse",
        )}
        style={indeterminate ? undefined : { width: `${clamped}%` }}
      />
    </div>
  )
}

export { Progress }
