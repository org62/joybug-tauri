import { useMemo } from 'react';
import { useSessionContext } from '@/contexts/SessionContext';
import { BreakpointsView } from '@/components/BreakpointsView';
import { contextToRegisters } from '@/lib/sessionHelpers';
import { useSymbolResolver } from '@/hooks/useSymbolResolver';

export function ContextBreakpointsView() {
  const sessionData = useSessionContext();
  const currentEvent = sessionData?.session?.current_event;

  const {
    breakpoints,
    toggleBreakpoint,
    addBreakpoints,
    addModuleBreakpoint,
    removeBreakpoint,
    removeBreakpoints,
    enableBreakpoint,
    enableBreakpointGroup,
    updateBreakpoint,
  } = sessionData.breakpointState;

  const registers = useMemo(() => {
    return contextToRegisters(currentEvent?.context);
  }, [currentEvent?.context]);

  const resolveSymbol = useSymbolResolver();

  return (
    <BreakpointsView
      breakpoints={breakpoints}
      onToggleBreakpoint={toggleBreakpoint}
      onAddBreakpoints={addBreakpoints}
      onAddModuleBreakpoint={sessionData.session ? addModuleBreakpoint : undefined}
      onRetryModuleBreakpoint={sessionData.canUseMemoryOps && !sessionData.session?.non_invasive
        ? (id) => enableBreakpoint(id, true) : undefined}
      onRemoveBreakpoint={removeBreakpoint}
      onRemoveBreakpoints={removeBreakpoints}
      onEnableBreakpoint={enableBreakpoint}
      onEnableBreakpointGroup={enableBreakpointGroup}
      onUpdateBreakpoint={updateBreakpoint}
      onNavigateToDisassembly={sessionData.onNavigateToDisassembly}
      registers={registers}
      resolveSymbol={resolveSymbol}
      canUseMemoryOps={sessionData.canUseMemoryOps}
    />
  );
}
