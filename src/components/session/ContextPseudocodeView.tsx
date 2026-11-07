import { useCallback, useMemo } from "react";
import { useSessionContext } from "@/contexts/SessionContext";
import { PseudocodeView } from "@/components/PseudocodeView";
import { useBreakpointAddresses } from "@/hooks/useBreakpointAddresses";
import type { DecompileFn, DecompileOutcome } from "@/hooks/usePseudocode";
import { parseAddress } from "@/lib/hexUtils";
import { perfInvoke } from "@/lib/perf";

export const ContextPseudocodeView = () => {
  const { session, isPaused, canUseMemoryOps, modules, symbolStatuses, breakpointState, patchState, onNavigateToDisassembly } = useSessionContext();
  const sessionId = session?.id;
  const address = session?.current_event?.address;
  const processId = session?.current_event?.process_id ?? session?.attach_pid ?? 0;
  const pseudocodeScope = `session:${sessionId}:${processId}`;

  const decompile = useMemo<DecompileFn | null>(() => {
    if (!sessionId) return null;
    return (target, client) => perfInvoke<DecompileOutcome>("decompile", "decompile_function", { sessionId, address: target, client }, sessionId);
  }, [sessionId]);

  // The view follows the PC only while the target stands still on it.
  const pcAddress = isPaused && address != null ? BigInt(address) : null;

  // What the function at an address is made from: the symbol state of its
  // module (when the debug file finishes loading, the function on screen gets
  // its names) and the patches applied, which change what "memory differs
  // from the file" says.
  const patchRevision = patchState.revision;
  const inputsKeyFor = useCallback(
    (target: bigint) => {
      const module = modules.find((m) => {
        const base = parseAddress(m.base_address);
        return base !== null && target >= base && target < base + BigInt(m.size);
      });
      const status = module && symbolStatuses.find((s) => s.base_address === module.base_address);
      const symbols = status ? `${status.status}:${status.symbol_count ?? 0}:${status.pdb_path ?? ""}` : "";
      return `${symbols}|${patchRevision}`;
    },
    [modules, symbolStatuses, patchRevision],
  );

  const breakpointAddresses = useBreakpointAddresses(breakpointState.breakpoints);

  return (
    <PseudocodeView
      key={pseudocodeScope}
      decompile={decompile}
      pseudocodeScope={pseudocodeScope}
      canLoad={canUseMemoryOps}
      pcAddress={pcAddress}
      inputsKeyFor={inputsKeyFor}
      breakpointAddresses={breakpointAddresses}
      onToggleBreakpoint={breakpointState.toggleBreakpoint}
      onNavigateToDisassembly={onNavigateToDisassembly}
    />
  );
};
