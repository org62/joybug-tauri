import { useMemo } from 'react';
import { useSessionContext } from '@/contexts/SessionContext';
import { BreakpointsView } from '@/components/BreakpointsView';
import { contextToRegisters, createSymbolResolver } from '@/lib/sessionHelpers';

export function ContextBreakpointsView() {
  const sessionData = useSessionContext();
  const currentEvent = sessionData?.session?.current_event;

  const {
    breakpoints,
    toggleBreakpoint,
    removeBreakpoint,
    removeBreakpoints,
    enableBreakpoint,
    enableBreakpointGroup,
    updateBreakpoint,
  } = sessionData.breakpointState;

  const registers = useMemo(() => {
    return contextToRegisters(currentEvent?.context);
  }, [currentEvent?.context]);

  const resolveSymbol = useMemo(
    () => createSymbolResolver(sessionData?.searchSymbols),
    [sessionData?.searchSymbols],
  );

  return (
    <BreakpointsView
      breakpoints={breakpoints}
      onToggleBreakpoint={toggleBreakpoint}
      onRemoveBreakpoint={removeBreakpoint}
      onRemoveBreakpoints={removeBreakpoints}
      onEnableBreakpoint={enableBreakpoint}
      onEnableBreakpointGroup={enableBreakpointGroup}
      onUpdateBreakpoint={updateBreakpoint}
      onNavigateToDisassembly={sessionData.onNavigateToDisassembly}
      registers={registers}
      resolveSymbol={resolveSymbol}
    />
  );
}
