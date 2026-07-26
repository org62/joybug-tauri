import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// House convention for "value changed since the last refresh/step" across all
// live-data views (registers, hex bytes, bookmarks, scan/search results, types).
// Elements styled with this also carry `data-changed` so tests and tooling can
// target the semantics instead of the class value.
export const CHANGED_VALUE_CLASS = "text-syn-changed"

// House convention for clickable data (addresses, symbols, jump targets) that
// navigates on click. Pairs with the `--syn-link` token: anything styled as a
// link must actually be clickable, so the color keeps its one-sentence meaning.
export const LINK_VALUE_CLASS = "text-syn-link cursor-pointer hover:underline"

// Current-PC row highlight shared by the disassembly and source views — the two
// must stay visually identical. The left bar is an inset shadow, not a border,
// so it costs no layout width and can't shift row content.
export const PC_ROW_HIGHLIGHT_CLASS =
  "bg-syn-state/[0.12] shadow-[inset_2px_0_0_var(--syn-state)]"

