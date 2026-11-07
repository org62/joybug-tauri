import { useMemo } from 'react';
import { useSessionContext } from '@/contexts/SessionContext';
import { AssemblyView } from '@/components/AssemblyView';
import { contextToRegisters, isProcessAvailable } from '@/lib/sessionHelpers';
import { appNavHistory } from '@/lib/navHistory';
import { useQuickEmulation } from '@/hooks/useQuickEmulation';
import { useSymbolResolver } from '@/hooks/useSymbolResolver';
import { useBreakpointAddresses } from '@/hooks/useBreakpointAddresses';

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

  const isPaused = sessionData.isPaused;
  const sessionId = sessionData?.session?.id;
  const processId = currentEvent?.process_id ?? sessionData.session?.attach_pid ?? 0;

  // Quick emulation is a session capability, so the hook lives in this wrapper —
  // the shared AssemblyView (also hosted by the PE viewer) just receives the state.
  // Auto-emulation is disabled for sandbox sessions: the probes are server-side
  // work reached over the guest's TCP link, and auto-firing them on every step
  // stalled stepping by ~8s each. The user can still trigger a probe by hand.
  const isSandbox = !!sessionData?.session?.sandbox;
  const emulation = useQuickEmulation(sessionId, isPaused, address, !isSandbox);

  const { breakpoints, toggleBreakpoint, setHardwareBreakpoint } = sessionData.breakpointState;
  const { assemblePatch, restoreImageBytes } = sessionData.patchState;
  const { addBookmark } = sessionData.bookmarkState;

  const breakpointAddresses = useBreakpointAddresses(breakpoints);

  return (
    <AssemblyView
      sessionId={sessionId}
      pseudocodeScope={`session:${sessionId}:${processId}`}
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
      onRestoreImageBytes={restoreImageBytes}
      onAddBookmark={(addr, asmText) => addBookmark({ kind: 'code', address: addr, asmText })}
      symbolsRefreshKey={sessionData.symbolsRefreshKey}
      symbolStatuses={sessionData.symbolStatuses}
      modules={sessionData.modules}
      onNavigateToSource={sessionData.onNavigateToSource}
      onNavigateToMemory={sessionData.onNavigateToMemory}
      onShowInMemoryRegions={sessionData.onNavigateToMemoryRegion}
      navHistory={appNavHistory}
    />
  );
};
