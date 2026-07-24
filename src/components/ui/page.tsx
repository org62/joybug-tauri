import * as React from "react"

import { cn } from "@/lib/utils"
import { ScrollArea } from "@/components/ui/scroll-area"

interface PageProps {
  className?: string
  style?: React.CSSProperties
  children?: React.ReactNode
  /**
   * When true (default) the page content scrolls inside a ScrollArea — routed
   * pages sit inside App's clipping `<main>`, so they must supply their own
   * scroll container. Set `scroll={false}` for pages that self-manage height
   * (e.g. a full-height flex layout with its own virtualized list).
   */
  scroll?: boolean
  /** Apply the standard `container mx-auto px-4 py-8` inner wrapper. */
  container?: boolean
}

function Page({
  className,
  children,
  scroll = true,
  container = true,
  ...props
}: PageProps) {
  const inner = container ? (
    <div className="container mx-auto px-4 py-8">{children}</div>
  ) : (
    children
  )

  if (!scroll) {
    return (
      <div
        data-slot="page"
        className={cn("h-full flex flex-col min-h-0", className)}
        {...props}
      >
        {inner}
      </div>
    )
  }

  return (
    <ScrollArea data-slot="page" className={cn("h-full", className)} {...props}>
      {inner}
    </ScrollArea>
  )
}

export { Page }
