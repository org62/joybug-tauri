import { useMemo } from 'react';
import { useSessionContext } from '@/contexts/SessionContext';
import { SourceView } from '@/components/SourceView';

export const ContextSourceView = () => {
  const sessionData = useSessionContext();
  const currentEvent = sessionData?.session?.current_event;

  const displayStatus = sessionData?.displayStatus;
  const address = currentEvent?.address;
  const isPaused = displayStatus === 'Paused';
  const sessionId = sessionData?.session?.id;

  const { breakpoints, toggleBreakpoint } = sessionData.breakpointState;

  // Uppercase-hex breakpoint addresses for the gutter; skip unresolved ("0x0").
  const breakpointAddresses = useMemo(() => {
    const set = new Set<string>();
    for (const bp of breakpoints) {
      if (bp.address !== '0x0') set.add(bp.address.toUpperCase());
    }
    return set;
  }, [breakpoints]);

  return (
    <SourceView
      sessionId={sessionId}
      isPaused={isPaused}
      address={address}
      symbolsRefreshKey={sessionData.symbolsRefreshKey}
      breakpointAddresses={breakpointAddresses}
      onToggleBreakpoint={toggleBreakpoint}
      onNavigateToDisassembly={sessionData.onNavigateToDisassembly}
    />
  );
};
