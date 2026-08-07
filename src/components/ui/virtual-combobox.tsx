import * as React from "react"
import { createPortal } from "react-dom"
import { ChevronDownIcon, CheckIcon } from "lucide-react"
import type { Virtualizer } from "@tanstack/react-virtual"

import { cn } from "@/lib/utils"
import { Input } from "@/components/ui/input"
import { selectTriggerClass } from "@/components/ui/select"
import { MiddleTruncate } from "@/components/ui/truncated-symbol"
import { VirtualizedList } from "@/components/ui/virtualized-list"
import {
  usePopoverDismiss,
  computeAnchoredDropdownRect,
  type AnchoredDropdownRect,
} from "@/hooks/usePopoverDismiss"

/**
 * Searchable dropdown for LARGE item lists (thousands of entries).
 *
 * Radix `Select` mounts every `SelectItem` into a detached DocumentFragment
 * even while closed (it needs the item text for `SelectValue`), so a Select
 * over a big list is re-reconciled in full on every parent render and lays
 * out every item on open. This component renders nothing while closed and
 * virtualizes the open list, so it stays O(visible rows) regardless of size.
 *
 * Not a Select replacement for small static lists — keep using `Select` there.
 */

export interface VirtualComboboxItem {
  /** Unique identity, also matched by the filter (e.g. a full file path). */
  value: string
  /** Primary row text (e.g. a file's short name). */
  label: string
  /** Muted secondary text (e.g. the directory), truncated from the head. */
  detail?: string
}

interface VirtualComboboxProps {
  items: VirtualComboboxItem[]
  value?: string | null
  onValueChange: (value: string) => void
  placeholder?: string
  searchPlaceholder?: string
  disabled?: boolean
  /** Trigger classes (sizing/width); the trigger shares SelectTrigger's surface. */
  className?: string
  /** Extra classes for the dropdown panel (e.g. `font-mono`). */
  panelClassName?: string
}

const ROW_HEIGHT = 24
const MAX_LIST_HEIGHT = 300
const PANEL_MIN_WIDTH = 280
/** Height of the search-input row (h-7 input + p-1 + border), for the height budget. */
const SEARCH_ROW_HEIGHT = 38

export function VirtualCombobox({
  items,
  value,
  onValueChange,
  placeholder = "Select...",
  searchPlaceholder = "Filter...",
  disabled,
  className,
  panelClassName,
}: VirtualComboboxProps) {
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState("")
  const [activeIndex, setActiveIndex] = React.useState(0)
  const [rect, setRect] = React.useState<AnchoredDropdownRect | null>(null)
  const triggerRef = React.useRef<HTMLButtonElement>(null)
  const panelRef = React.useRef<HTMLDivElement>(null)
  const virtualizerRef = React.useRef<Virtualizer<HTMLDivElement, Element>>(null)

  const selected = React.useMemo(() => items.find((i) => i.value === value), [items, value])

  // Lowercased haystacks built once per items change, so a keystroke over
  // thousands of items is a scan, not thousands of fresh string allocations.
  const haystack = React.useMemo(
    () => items.map((i) => `${i.label}\n${i.value}`.toLowerCase()),
    [items],
  )
  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return items
    return items.filter((_, k) => haystack[k].includes(q))
  }, [items, haystack, query])

  const setActive = React.useCallback((index: number, align?: "center") => {
    setActiveIndex(index)
    virtualizerRef.current?.scrollToIndex(index, align ? { align } : undefined)
  }, [])

  const close = React.useCallback(() => {
    setOpen(false)
    triggerRef.current?.focus()
  }, [])

  // captureEscape: the autofocused search input means Escape must be consumed
  // before hosts that treat it as "close".
  usePopoverDismiss(open, close, triggerRef, panelRef, { captureEscape: true })

  const openPanel = () => {
    const el = triggerRef.current
    if (!el) return
    setRect(
      computeAnchoredDropdownRect(el, {
        minWidth: PANEL_MIN_WIDTH,
        maxHeightCap: SEARCH_ROW_HEIGHT + MAX_LIST_HEIGHT,
        flip: true,
      }),
    )
    setQuery("")
    // Start on the selected item (query was just reset, so the list is unfiltered).
    const idx = value != null ? items.findIndex((i) => i.value === value) : -1
    setActiveIndex(Math.max(idx, 0))
    setOpen(true)
    // Deferred so the portal/virtualizer is mounted before the scroll.
    if (idx >= 0) requestAnimationFrame(() => virtualizerRef.current?.scrollToIndex(idx, { align: "center" }))
  }

  const select = (v: string) => {
    onValueChange(v)
    close()
  }

  const moveActive = (delta: number) => {
    if (filtered.length === 0) return
    setActive(Math.min(Math.max(activeIndex + delta, 0), filtered.length - 1))
  }

  const handleInputKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault()
      moveActive(1)
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      moveActive(-1)
    } else if (e.key === "Enter") {
      e.preventDefault()
      const item = filtered[activeIndex]
      if (item) select(item.value)
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        data-slot="virtual-combobox-trigger"
        data-size="xs"
        data-placeholder={selected ? undefined : ""}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={selected?.value}
        onClick={() => (open ? setOpen(false) : openPanel())}
        className={cn(selectTriggerClass, className)}
      >
        <span className="truncate min-w-0">{selected ? selected.label : placeholder}</span>
        <ChevronDownIcon className="size-4 opacity-50" />
      </button>

      {open && rect &&
        createPortal(
          <div
            ref={panelRef}
            role="listbox"
            data-slot="virtual-combobox-panel"
            className={cn(
              // z-[60] + propagation stops: usable inside Radix dialogs, whose
              // content sits at z-[51] and dismisses on outside pointerdowns
              // (same treatment as HistoryInput's dropdown).
              "fixed z-[60] flex flex-col rounded-md border bg-popover text-popover-foreground shadow-md overflow-hidden",
              panelClassName,
            )}
            style={{ left: rect.left, top: rect.top, bottom: rect.bottom, width: rect.width }}
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="p-1 border-b border-border">
              <Input
                inputSize="xs"
                autoFocus
                value={query}
                placeholder={searchPlaceholder}
                onChange={(e) => {
                  setQuery(e.target.value)
                  setActive(0)
                }}
                onKeyDown={handleInputKeyDown}
              />
            </div>
            {filtered.length === 0 ? (
              <div className="py-4 text-center text-xs text-muted-foreground">No matches</div>
            ) : (
              <VirtualizedList
                items={filtered}
                rowHeight={ROW_HEIGHT}
                overscan={10}
                style={{ height: Math.min(filtered.length * ROW_HEIGHT, rect.maxHeight - SEARCH_ROW_HEIGHT) }}
                virtualizerRef={virtualizerRef}
                getItemKey={(item) => item.value}
                renderItem={(item, index) => {
                  const isSelected = item.value === value
                  return (
                    <div
                      role="option"
                      aria-selected={isSelected}
                      title={item.value}
                      className={cn(
                        "flex items-center gap-1.5 px-2 h-full text-xs cursor-default select-none",
                        index === activeIndex && "bg-accent text-accent-foreground",
                      )}
                      onMouseMove={() => setActiveIndex(index)}
                      onClick={() => select(item.value)}
                    >
                      <CheckIcon
                        className={cn("size-3.5 shrink-0", isSelected ? "opacity-100" : "opacity-0")}
                      />
                      <span className="truncate shrink-0 max-w-[60%]">{item.label}</span>
                      {item.detail && (
                        <MiddleTruncate text={item.detail} className="ml-auto text-muted-foreground" />
                      )}
                    </div>
                  )
                }}
              />
            )}
          </div>,
          document.body,
        )}
    </>
  )
}
