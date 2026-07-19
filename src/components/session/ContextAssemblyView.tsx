import { useMemo } from 'react';
import { useSessionContext } from '@/contexts/SessionContext';
import { AssemblyView } from '@/components/AssemblyView';
import { contextToRegisters, isProcessAvailable } from '@/lib/sessionHelpers';
import { sessionNavHistory } from '@/lib/navHistory';
import { useQuickEmulation } from '@/hooks/useQuickEmulation';
import { useSymbolResolver } from '@/hooks/useSymbolResolver';

export const ContextAssemblyView = () => {
  const sessionData = useSessionContext();
  const currentEvent = sessionData?.session?.current_event;

  // Use displayStatus (debounced) to prevent flicker during stepping
  const displayStatus = sessionData?.displayStatus;
  // Always pass last known address so disassembly stays visible while running
  const address = currentEvent?.address;

  const registers = useMemo(() => {
    return contextToRegisters(currentEvent?.context);
  }, [currentEvent?.context]);

  const resolveSymbol = useSymbolResolver();

  const isPaused = displayStatus === 'Paused';
  const sessionId = sessionData?.session?.id;

  // Quick emulation is a session capability, so the hook lives in this wrapper —
  // the shared AssemblyView (also hosted by the PE viewer) just receives the state.
  const emulation = useQuickEmulation(sessionId, isPaused, address);

  const { breakpoints, toggleBreakpoint, setHardwareBreakpoint } = sessionData.breakpointState;
  const { assemblePatch } = sessionData.patchState;
  const { addBookmark } = sessionData.bookmarkState;

  // Build a set of breakpoint addresses (uppercase hex) for quick lookup.
  // Exclude unresolved breakpoints (address "0x0") since they have no real location yet.
  const breakpointAddresses = useMemo(() => {
    const set = new Set<string>();
    for (const bp of breakpoints) {
      if (bp.address !== "0x0") {
        set.add(bp.address.toUpperCase());
      }
    }
    return set;
  }, [breakpoints]);

  return (
    <AssemblyView
      sessionId={sessionId}
      isPaused={isPaused}
      canLoad={isProcessAvailable(displayStatus)}
      address={address}
      registers={registers}
      resolveSymbol={resolveSymbol}
      breakpointAddresses={breakpointAddresses}
      emulation={emulation}
      onToggleBreakpoint={toggleBreakpoint}
      onToggleSingleShotBreakpoint={(address) => toggleBreakpoint(address, true)}
      onSetHardwareBreakpoint={setHardwareBreakpoint}
      onAssemblePatch={assemblePatch}
      onAddBookmark={(addr, asmText) => addBookmark({ kind: 'code', address: addr, asmText })}
      symbolsRefreshKey={sessionData.symbolsRefreshKey}
      onNavigateToSource={sessionData.onNavigateToSource}
      navHistory={sessionNavHistory}
    />
  );
};
