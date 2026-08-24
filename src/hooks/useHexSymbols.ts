import { useEffect, useMemo, useRef, useState } from "react";
import { EMPTY_SYMBOLS, HexLabel, HexSymbol } from "@/lib/hexRows";
import { formatTauriError, isBenignSessionError } from "@/lib/sessionHelpers";

/** One annotated address as the source reports it. */
export interface HexSymbolHit {
  address: bigint;
  label: string;
}

/** Resolves every module symbol inside `[start, start + size)`. */
export type HexSymbolSource = (start: bigint, size: number) => Promise<HexSymbolHit[]>;

/** A label the host already knows the address of (bookmarks). */
export interface HexExtraLabel {
  address: bigint;
  label: HexLabel;
}

const NO_EXTRA: HexExtraLabel[] = [];
const NO_HITS: HexSymbolHit[] = [];

interface UseHexSymbolsOptions {
  source?: HexSymbolSource;
  /** Toggle on, a symbol source exists, and a process is available. */
  enabled: boolean;
  baseAddress: bigint;
  /** Window length — not the byte array itself, so live-refresh ticks that
   *  re-read the same window don't refetch. */
  length: number;
  /** Identity of the set of modules with loaded symbols: PDBs landing after
   *  the first fetch upgrade export-only names, so refetch when it flips. */
  refreshKey?: string;
  extra?: HexExtraLabel[];
}

/** The window a fetch answered for, so a contained window can reuse it. */
interface FetchedRange {
  source: HexSymbolSource;
  refreshKey: string | undefined;
  start: bigint;
  end: bigint;
}

/**
 * Symbols to annotate the hex view's current window with, merged with any
 * host-supplied labels, grouped per address and sorted ascending. Returns the
 * shared `EMPTY_SYMBOLS` reference whenever there is nothing to show so the
 * row-model memo downstream stays quiet.
 */
export function useHexSymbols({
  source,
  enabled,
  baseAddress,
  length,
  refreshKey,
  extra = NO_EXTRA,
}: UseHexSymbolsOptions): HexSymbol[] {
  const [fetched, setFetched] = useState<HexSymbolHit[]>(NO_HITS);
  // Widest window already answered for. A prepend/append/goto that lands
  // inside it is served from `fetched` (the memo clips to the live window),
  // which is what keeps a stepping burst — every pause re-follows the stack
  // pointer and moves the window — from firing one OOB query per step.
  const fetchedRangeRef = useRef<FetchedRange | null>(null);

  useEffect(() => {
    if (!source || !enabled || length === 0) return;
    const start = baseAddress;
    const end = baseAddress + BigInt(length);
    const cached = fetchedRangeRef.current;
    if (cached) {
      const sameSource = cached.source === source && cached.refreshKey === refreshKey;
      if (!sameSource) {
        // A different session or a PDB that just landed: the old names may be
        // wrong for these addresses, so drop them rather than show them.
        fetchedRangeRef.current = null;
        setFetched(NO_HITS);
      } else if (start >= cached.start && end <= cached.end) {
        return;
      }
    }
    // Every dep change re-runs this effect and the previous run's cleanup
    // flips its flag, so a fetch for an old window can never land after a
    // newer one. The previous symbols stay visible until the new set arrives
    // (a prepend/append must not flash the labels away).
    let stale = false;
    source(start, length)
      .then((list) => {
        if (stale) return;
        fetchedRangeRef.current = { source, refreshKey, start, end };
        setFetched(list);
      })
      .catch((err) => {
        // Advisory decoration, like the pointer-mode dereference chain: never a
        // toast. A process that went away is expected; anything else is a real
        // regression and must not vanish silently.
        const message = formatTauriError(err);
        if (!stale && !isBenignSessionError(message)) {
          console.warn("hex symbols fetch failed", message);
        }
      });
    return () => {
      stale = true;
    };
  }, [source, enabled, baseAddress, length, refreshKey]);

  return useMemo(() => {
    if (!enabled) return EMPTY_SYMBOLS;
    const end = baseAddress + BigInt(length);
    const byAddress = new Map<bigint, HexLabel[]>();
    const add = (address: bigint, label: HexLabel) => {
      // `fetched` can cover a wider window than the live one (see the range
      // cache above), so this clip is load-bearing for both inputs.
      if (address < baseAddress || address >= end) return;
      const labels = byAddress.get(address);
      if (!labels) {
        byAddress.set(address, [label]);
      } else if (!labels.some((l) => l.kind === label.kind && l.text === label.text)) {
        labels.push(label);
      }
    };
    // Module symbols first so they lead the row; bookmarks follow.
    for (const s of fetched) add(s.address, { text: s.label, kind: "symbol" });
    for (const e of extra) add(e.address, e.label);
    if (byAddress.size === 0) return EMPTY_SYMBOLS;
    return [...byAddress.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([address, labels]) => ({ address, labels }));
  }, [enabled, baseAddress, length, fetched, extra]);
}
