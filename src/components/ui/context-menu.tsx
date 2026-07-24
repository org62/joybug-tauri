import * as React from "react"
import { createPortal } from "react-dom"

import { cn } from "@/lib/utils"

/**
 * Lightweight coordinate-positioned context menu.
 *
 * Matches the app's existing right-click UX (a `{x,y}`-positioned popup) but
 * centralizes styling and outside-click / Escape handling so views stop
 * hand-rolling `fixed z-50` popups full of raw `<button>`s.
 *
 *   {menu && (
 *     <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
 *       <ContextMenuItem icon={<Copy />} onClick={copy}>Copy</ContextMenuItem>
 *       <ContextMenuSeparator />
 *       <ContextMenuItem destructive icon={<Trash2 />} onClick={del}>Delete</ContextMenuItem>
 *     </ContextMenu>
 *   )}
 */

const ContextMenuCloseCtx = React.createContext<() => void>(() => {})

interface ContextMenuProps {
  x: number
  y: number
  onClose: () => void
  className?: string
  children: React.ReactNode
}

function ContextMenu({ x, y, onClose, className, children }: ContextMenuProps) {
  const ref = React.useRef<HTMLDivElement>(null)
  const [pos, setPos] = React.useState({ x, y })

  React.useEffect(() => {
    const handlePointer = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("mousedown", handlePointer)
    document.addEventListener("keydown", handleKey)
    return () => {
      document.removeEventListener("mousedown", handlePointer)
      document.removeEventListener("keydown", handleKey)
    }
  }, [onClose])

  // Keep the menu inside the viewport.
  React.useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    let nx = x
    let ny = y
    if (x + rect.width > window.innerWidth)
      nx = Math.max(4, window.innerWidth - rect.width - 4)
    if (y + rect.height > window.innerHeight)
      ny = Math.max(4, window.innerHeight - rect.height - 4)
    setPos({ x: nx, y: ny })
  }, [x, y])

  return createPortal(
    <ContextMenuCloseCtx.Provider value={onClose}>
      <div
        ref={ref}
        role="menu"
        data-slot="context-menu"
        className={cn(
          "fixed z-50 min-w-[160px] rounded-md border bg-popover text-popover-foreground shadow-md py-1",
          className
        )}
        style={{ left: pos.x, top: pos.y }}
      >
        {children}
      </div>
    </ContextMenuCloseCtx.Provider>,
    document.body
  )
}

interface ContextMenuItemProps extends React.ComponentProps<"button"> {
  icon?: React.ReactNode
  destructive?: boolean
  /** Keep the menu open after clicking (default: close). */
  closeOnSelect?: boolean
}

function ContextMenuItem({
  className,
  children,
  icon,
  destructive,
  closeOnSelect = true,
  onClick,
  ...props
}: ContextMenuItemProps) {
  const close = React.useContext(ContextMenuCloseCtx)
  return (
    <button
      role="menuitem"
      className={cn(
        "w-full px-3 py-1.5 text-sm text-left flex items-center gap-2 outline-hidden hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        destructive && "text-destructive hover:bg-destructive/10",
        className
      )}
      onClick={(e) => {
        onClick?.(e)
        if (closeOnSelect) close()
      }}
      {...props}
    >
      {icon}
      {children}
    </button>
  )
}

function ContextMenuSeparator({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      role="separator"
      className={cn("border-t border-border my-1", className)}
      {...props}
    />
  )
}

export {
  ContextMenu,
  ContextMenuItem,
  ContextMenuSeparator,
}
