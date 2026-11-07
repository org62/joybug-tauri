import { useMemo } from "react";

/**
 * The addresses that carry a breakpoint, as uppercase hex, for a listing's
 * gutter. An unresolved breakpoint ("0x0") has no location yet and is left out.
 */
export function useBreakpointAddresses(breakpoints: readonly { address: string }[]): Set<string> {
  return useMemo(() => {
    const set = new Set<string>();
    for (const bp of breakpoints) {
      if (bp.address !== "0x0") set.add(bp.address.toUpperCase());
    }
    return set;
  }, [breakpoints]);
}
