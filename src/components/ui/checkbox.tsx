import * as React from "react"

import { cn } from "@/lib/utils"

// Lightweight native-input checkbox (no Radix dependency). Sized for dense
// list rows — the one checkbox size used across panel views.
function Checkbox({
  className,
  ...props
}: Omit<React.ComponentProps<"input">, "type">) {
  return (
    <input
      type="checkbox"
      data-slot="checkbox"
      className={cn(
        "size-3.5 shrink-0 accent-primary outline-none focus-visible:ring-ring/50 focus-visible:ring-[3px] rounded-sm disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    />
  )
}

export { Checkbox }
