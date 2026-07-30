import { useMemo } from 'react';
import { useSessionContext } from '@/contexts/SessionContext';
import { HexView } from '@/components/HexView';
import { ViewMode } from '@/lib/hexUtils';
import { contextToRegisters } from '@/lib/sessionHelpers';
import { useSymbolResolver } from '@/hooks/useSymbolResolver';

interface ContextHexViewProps {
  memoryViewId?: string;
  initialAddress?: bigint;
  initialViewMode?: ViewMode;
}

export const ContextHexView = ({ memoryViewId, initialAddress, initialViewMode }: ContextHexViewProps) => {
  const sessionData = useSessionContext();
  const context = sessionData?.session?.current_event?.context;

  // Extract registers from thread context
  const registers = useMemo(() => contextToRegisters(context), [context]);

  const resolveSymbolFn = useSymbolResolver();

  // Get session status as string
  const sessionStatus = sessionData?.session?.status;
  const statusString = typeof sessionStatus === 'string' ? sessionStatus : undefined;

  const { setHardwareBreakpoint } = sessionData.breakpointState;
  const { addBookmark } = sessionData.bookmarkState;

  return (
    <HexView
      sessionId={sessionData?.session?.id}
      memoryViewId={memoryViewId}
      sessionStatus={statusString}
      registers={registers}
      resolveSymbol={resolveSymbolFn}
      symbolsRefreshKey={sessionData.symbolsRefreshKey}
      initialAddress={initialAddress}
      initialViewMode={initialViewMode}
      onSetHardwareBreakpoint={setHardwareBreakpoint}
      onAddBookmark={(address, valueType) => addBookmark({ kind: 'value', address, valueType })}
      onFindAccesses={sessionData.onFindAccesses}
      onShowInMemoryRegions={sessionData.onNavigateToMemoryRegion}
    />
  );
};
