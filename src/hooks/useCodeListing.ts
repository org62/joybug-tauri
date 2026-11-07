import { useEffect, useMemo, useState } from "react";
import { NAV_HIGHLIGHT_MS } from "@/lib/utils";

// What the code views built on `CodeLineRow` (source text, pseudocode) share
// besides the row.

/** The lines carrying a breakpoint: any of the line's addresses is set.
 *  `breakpointAddresses` holds uppercase hex. */
export function useBreakpointLines(lineAddresses: ReadonlyMap<number, string[]> | undefined, breakpointAddresses?: Set<string>): Set<number> {
  return useMemo(() => {
    const lines = new Set<number>();
    if (!lineAddresses || !breakpointAddresses || breakpointAddresses.size === 0) return lines;
    for (const [line, addresses] of lineAddresses) {
      if (addresses.some((a) => breakpointAddresses.has(a.toUpperCase()))) lines.add(line);
    }
    return lines;
  }, [lineAddresses, breakpointAddresses]);
}

/**
 * Width of a listing's content, wide enough for its longest line (at least
 * `minChars`), so long lines scroll horizontally. The pad covers the fixed
 * gutters (breakpoint + PC columns) and the line-number column.
 */
export function useListingWidth(lines: readonly string[] | undefined, numDigits: number, minChars: number): string {
  return useMemo(() => {
    let max = minChars;
    for (const line of lines ?? []) if (line.length > max) max = line.length;
    return `${max + numDigits + 8}ch`;
  }, [lines, numDigits, minChars]);
}

/** The line to flash: `target`'s, for a moment after each new target. */
export function useLineFlash(target: { line: number } | null | undefined): number | null {
  const [flashLine, setFlashLine] = useState<number | null>(null);
  useEffect(() => {
    if (!target) return;
    setFlashLine(target.line);
    const timer = setTimeout(() => setFlashLine(null), NAV_HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [target]);
  return flashLine;
}
