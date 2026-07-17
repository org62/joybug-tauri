import { useCallback, useMemo } from 'react';
import { useSessionContext, Symbol } from '@/contexts/SessionContext';
import { useContextMenu } from '@/hooks/useContextMenu';
import { invokeToggleBreakpoint, invokeSetBreakpoints } from '@/lib/sessionHelpers';
import { Button } from '@/components/ui/button';
import { ContextMenu, ContextMenuItem } from '@/components/ui/context-menu';
import { SymbolSearchView } from '@/components/SymbolSearchView';

export const ContextSymbolsView = () => {
  const sessionData = useSessionContext();
  const isActive = sessionData.canUseMemoryOps;
  const sessionId = sessionData?.session?.id;

  const onNavigateToDisassembly = sessionData.onNavigateToDisassembly;
  const onNavigateToMemory = sessionData.onNavigateToMemory;
  const searchSymbols = sessionData.searchSymbols;

  const { contextMenu, openContextMenu, closeContextMenu } = useContextMenu<{ va: string; is_function: boolean }>();

  const loadedCount = useMemo(
    () => (sessionData.symbolStatuses ?? []).filter((s) => s.status === 'loaded').length,
    [sessionData.symbolStatuses],
  );

  const toggleBreakpoint = useCallback(async (address: string) => {
    if (!sessionId) return;
    try {
      await invokeToggleBreakpoint(sessionId, address);
    } catch (e) {
      console.error('Failed to toggle breakpoint:', e);
    }
  }, [sessionId]);

  const onSelect = useCallback((symbol: Symbol) => {
    if (symbol.is_function) {
      onNavigateToDisassembly?.(symbol.va);
    } else {
      onNavigateToMemory?.(symbol.va);
    }
  }, [onNavigateToDisassembly, onNavigateToMemory]);

  const setBreakpointsForSymbols = useCallback(async (symbols: Symbol[], term: string, clear: () => void) => {
    if (!sessionId || symbols.length === 0) return;
    try {
      // Group by the search term so the breakpoints can be enabled/removed as a unit;
      // fall back to a generic name if the term is empty (unlikely — search needs 2+ chars).
      const group = term || 'Symbols';
      await invokeSetBreakpoints(sessionId, symbols.map((s) => s.va), group);
      clear();
    } catch (e) {
      console.error('Failed to set breakpoints:', e);
    }
  }, [sessionId]);

  return (
    <SymbolSearchView<Symbol>
      searchSymbols={searchSymbols}
      enabled={!!sessionId && isActive}
      placeholder={isActive ? "Search symbols..." : "Open, attach to, or run a process to search symbols"}
      idleTitle={isActive ? `Symbols for ${loadedCount} module${loadedCount === 1 ? '' : 's'} are loaded` : undefined}
      onSelect={onSelect}
      onRowContextMenu={(e, symbol) => openContextMenu(e, { va: symbol.va, is_function: symbol.is_function })}
      resetKey={sessionId}
      focusTabId="symbols"
      selectable
      renderBulkBar={(selectedSymbols, { term, clear }) => (
        <Button
          size="xs"
          disabled={selectedSymbols.length === 0}
          onClick={() => setBreakpointsForSymbols(selectedSymbols, term, clear)}
        >
          Set Breakpoints{selectedSymbols.length > 0 ? ` (${selectedSymbols.length})` : ''}
        </Button>
      )}
    >
      {contextMenu && (
        <ContextMenu x={contextMenu.x} y={contextMenu.y} onClose={closeContextMenu} className="min-w-[180px]">
          {onNavigateToDisassembly && (
            <ContextMenuItem onClick={() => onNavigateToDisassembly(contextMenu.data.va)}>
              Go to Disassembly
            </ContextMenuItem>
          )}
          {onNavigateToMemory && (
            <ContextMenuItem onClick={() => onNavigateToMemory(contextMenu.data.va)}>
              Go to Memory View
            </ContextMenuItem>
          )}
          <ContextMenuItem onClick={() => toggleBreakpoint(contextMenu.data.va)}>
            Toggle Breakpoint
          </ContextMenuItem>
        </ContextMenu>
      )}
    </SymbolSearchView>
  );
};
