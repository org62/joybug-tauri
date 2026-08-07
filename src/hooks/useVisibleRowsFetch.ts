import { useCallback, useEffect, useRef } from 'react';
import { Virtualizer } from '@tanstack/react-virtual';

/**
 * Scaffolding for lazily fetching per-row data for the rows a virtualized list
 * is actually rendering: debounced scheduling, an in-flight gate, and
 * visible-row extraction from the virtualizer (first 64 items before the list
 * mounts). Used by the symbol-search and memory-search result lists.
 *
 * The caller owns the fetched state; `fetchVisible` receives the visible items
 * and returns false when there was nothing left to fetch. Errors are swallowed
 * — a later scroll/poll retries. With `followUp`, a fetch that did work
 * schedules one more pass to catch rows scrolled in while it was in flight;
 * this converges instead of retry-looping because a pass with nothing missing
 * returns false (leave it off when an outer live-poll cadence refreshes anyway).
 *
 * Pass the returned `virtualizerRef` to the view's `<VirtualizedList>`; wire
 * `schedule` to scroll/first-render triggers and `fetchNow` to immediate ones.
 */
export function useVisibleRowsFetch<T>({ items, fetchVisible, followUp = false, debounceMs = 100 }: {
  items: T[];
  fetchVisible: (visible: T[]) => Promise<boolean | void>;
  followUp?: boolean;
  debounceMs?: number;
}) {
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const virtualizerRef = useRef<Virtualizer<HTMLDivElement, Element> | null>(null);
  const inFlightRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fetchNowRef = useRef<() => void>(() => {});

  const schedule = useCallback(() => {
    if (timerRef.current) return;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      fetchNowRef.current();
    }, debounceMs);
  }, [debounceMs]);
  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const fetchNow = useCallback(async () => {
    if (inFlightRef.current) return;
    const all = itemsRef.current;
    if (all.length === 0) return;
    const virtualizer = virtualizerRef.current;
    const visible = virtualizer
      ? virtualizer.getVirtualItems().map((row) => all[row.index]).filter((it): it is T => it !== undefined)
      : all.slice(0, 64);
    if (visible.length === 0) return;

    inFlightRef.current = true;
    let didWork = false;
    try {
      didWork = (await fetchVisible(visible)) !== false;
    } catch {
      // Background enrichment; the rows stay data-less and a later pass retries.
    } finally {
      inFlightRef.current = false;
      if (followUp && didWork) schedule();
    }
  }, [fetchVisible, followUp, schedule]);
  fetchNowRef.current = fetchNow;

  return { virtualizerRef, schedule, fetchNow };
}
