import { useSessionContext } from '@/contexts/SessionContext';
import { SourceView } from '@/components/SourceView';
import { useBreakpointAddresses } from '@/hooks/useBreakpointAddresses';

export const ContextSourceView = () => {
  const sessionData = useSessionContext();
  const currentEvent = sessionData?.session?.current_event;

  const address = currentEvent?.address;
  const isPaused = sessionData.isPaused;
  const sessionId = sessionData?.session?.id;

  const { breakpoints, toggleBreakpoint } = sessionData.breakpointState;

  const breakpointAddresses = useBreakpointAddresses(breakpoints);

  // The source view re-resolves when symbols land and when a line table
  // does: a lookup that found the table still being parsed is answered
  // "pending", and this is what tells the view to ask again.
  const refreshKey = `${sessionData.symbolsRefreshKey}|${sessionData.lineTablesReadyKey}`;

  return (
    <SourceView
      sessionId={sessionId}
      isPaused={isPaused}
      canUseMemoryOps={sessionData.canUseMemoryOps}
      address={address}
      symbolsRefreshKey={refreshKey}
      breakpointAddresses={breakpointAddresses}
      onToggleBreakpoint={toggleBreakpoint}
      onNavigateToDisassembly={sessionData.onNavigateToDisassembly}
    />
  );
};
