import { useCallback, useMemo } from "react";
import { useSessionContext } from "@/contexts/SessionContext";
import { createSymbolResolver } from "@/lib/sessionHelpers";
import { resolveSymbol } from "@/lib/symbolUtils";
import type { SymbolResolver } from "@/lib/hexUtils";
import type { SymbolResolverWithName } from "@/components/RegisterEditDialog";

/**
 * Memoized symbol resolver for session views: delegates to the session's
 * searchSymbols and resolves bare module names against the loaded module list.
 * Single assembly point so every view picks up new resolver inputs together.
 */
export function useSymbolResolver(): SymbolResolver {
  const sessionData = useSessionContext();
  return useMemo(
    () => createSymbolResolver(sessionData?.searchSymbols, sessionData?.modules),
    [sessionData?.searchSymbols, sessionData?.modules],
  );
}

/** Like useSymbolResolver, but also returns the matched symbol's display name. */
export function useSymbolResolverWithName(): SymbolResolverWithName {
  const sessionData = useSessionContext();
  return useCallback(async (name: string) => {
    if (!sessionData?.searchSymbols) return null;
    try {
      return await resolveSymbol(sessionData.searchSymbols, name, sessionData.modules);
    } catch {
      return null;
    }
  }, [sessionData?.searchSymbols, sessionData?.modules]);
}
