import { useMemo } from "react";
import { useSessionContext } from "@/contexts/SessionContext";
import { contextToRegisters, isTargetLive } from "@/lib/sessionHelpers";
import { useSymbolResolver } from "@/hooks/useSymbolResolver";
import { TypesView } from "@/components/TypesView";

export const ContextTypesView = () => {
  const sessionData = useSessionContext();
  const sessionId = sessionData?.session?.id;

  const registers = useMemo(
    () => contextToRegisters(sessionData?.session?.current_event?.context),
    [sessionData?.session?.current_event?.context],
  );
  const resolveSymbol = useSymbolResolver();

  return (
    <TypesView
      sessionId={sessionId}
      isActive={sessionData.canUseMemoryOps}
      isLive={isTargetLive(sessionData.displayStatus)}
      registers={registers}
      resolveSymbol={resolveSymbol}
      onNavigateToMemory={sessionData.onNavigateToMemory}
      focusTabId="types"
    />
  );
};
