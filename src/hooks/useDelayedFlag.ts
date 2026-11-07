import { useEffect, useState } from "react";

/** The delay for a loading state: a load shorter than this is not announced,
 *  and whatever was on screen stays until the answer replaces it. */
export const LOADING_STATE_DELAY_MS = 200;

/**
 * `flag`, but turning true only once it has stayed true for `delayMs`; it
 * turns false at once.
 *
 * For "loading" indicators: most loads finish in a few milliseconds, and a
 * state that appears and disappears that fast is a flicker, not information.
 * The indicator shows up only for a load slow enough to need one.
 */
export function useDelayedFlag(flag: boolean, delayMs: number): boolean {
  const [delayed, setDelayed] = useState(false);
  useEffect(() => {
    if (!flag) {
      setDelayed(false);
      return;
    }
    const timer = setTimeout(() => setDelayed(true), delayMs);
    return () => clearTimeout(timer);
  }, [flag, delayMs]);
  return flag && delayed;
}
