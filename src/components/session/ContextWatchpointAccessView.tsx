import { useSessionContext } from '@/contexts/SessionContext';
import { WatchpointAccessView } from '@/components/WatchpointAccessView';

export function ContextWatchpointAccessView() {
  const sessionData = useSessionContext();
  const { traces, stopTrace, clearRows } = sessionData.watchpointState;

  return (
    <WatchpointAccessView
      traces={traces}
      onStopTrace={stopTrace}
      onClearRows={clearRows}
      onNavigateToDisassembly={sessionData.onNavigateToDisassembly}
    />
  );
}
