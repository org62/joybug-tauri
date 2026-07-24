import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// House convention for "value changed since the last refresh/step" across all
// live-data views (registers, hex bytes, bookmarks, scan/search results, types).
// Elements styled with this also carry `data-changed` so tests and tooling can
// target the semantics instead of the class value.
export const CHANGED_VALUE_CLASS = "text-red-400"

