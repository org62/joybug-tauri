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

// How long a navigation target (disassembly row, source line) keeps the
// `animate-highlight-fade` class. Matches the CSS animation duration in
// App.css so the class is removed exactly when the fade reaches transparent —
// shorter would cut the fade off visibly, longer would leave a stale
// `forwards` fill blocking row-state backgrounds.
export const NAV_HIGHLIGHT_MS = 2500

// Row height for every virtualized data listing (disassembly, source, hex,
// emulation trace) — they are the same kind of data and must read equally
// dense. This is the numeric half of the `text-data` token in App.css: the
// token's line-height and this constant are the same 18px, so a row is exactly
// one line of text. Change both together.
export const DATA_ROW_HEIGHT = 18

