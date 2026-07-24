import { useEffect, useMemo, useRef } from 'react';

/**
 * Change-detection baseline for live-value views (the counterpart of
 * `useLiveRefresh`, which owns the polling cadence): returns the set of keys
 * whose value differs from the previous distinct `items` array.
 *
 * Semantics shared by all consumers:
 * - The baseline advances only on genuinely-new data (array reference
 *   identity), so re-renders never clear a highlight.
 * - It deliberately survives Running→Paused, so a step highlights what changed
 *   (same semantics as the hex view).
 * - Keys absent from the baseline (new items) don't flash.
 * - An empty `items` array doesn't advance the baseline; the baseline resets
 *   only when `resetKey` changes (session end, new scan, ...).
 */
export function useChangedValues<T>(
  items: T[],
  getKey: (item: T) => string,
  getValue: (item: T) => string | null,
  resetKey?: unknown,
): Set<string> {
  const prevValuesRef = useRef<Map<string, string | null> | null>(null);
  const lastSeenRef = useRef<T[] | null>(null);

  // Extractors are often inline arrows; keep them out of dep arrays via refs.
  const getKeyRef = useRef(getKey);
  getKeyRef.current = getKey;
  const getValueRef = useRef(getValue);
  getValueRef.current = getValue;

  useEffect(() => {
    prevValuesRef.current = null;
    lastSeenRef.current = null;
  }, [resetKey]);

  // Diff against the baseline before the advance effect below runs.
  const changed = useMemo(() => {
    const set = new Set<string>();
    const prev = prevValuesRef.current;
    if (!prev) return set;
    for (const item of items) {
      const key = getKeyRef.current(item);
      if (prev.has(key) && prev.get(key) !== getValueRef.current(item)) set.add(key);
    }
    return set;
  }, [items]);

  useEffect(() => {
    if (items === lastSeenRef.current || items.length === 0) return;
    lastSeenRef.current = items;
    prevValuesRef.current = new Map(
      items.map((item) => [getKeyRef.current(item), getValueRef.current(item)]),
    );
  }, [items]);

  return changed;
}
