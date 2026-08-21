import { useCallback, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useSessionContext, Symbol, hasUsableSymbols } from '@/contexts/SessionContext';
import { useContextMenu } from '@/hooks/useContextMenu';
import { invokeToggleBreakpoint, invokeSetBreakpoints } from '@/lib/sessionHelpers';
import { Button } from '@/components/ui/button';
import { ContextMenu, ContextMenuItem } from '@/components/ui/context-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { SymbolSearchView, SymbolPreview } from '@/components/SymbolSearchView';

/**
 * Above this many symbols, a mass breakpoint apply asks first: a search returns
 * up to SEARCH_LIMIT hits, so one Select All is enough to arm thousands of
 * breakpoints by accident.
 */
const BULK_CONFIRM_THRESHOLD = 500;

/** A mass breakpoint apply awaiting confirmation. */
interface PendingBulk {
  symbols: Symbol[];
  term: string;
  clear: () => void;
  singleShot: boolean;
}

export const ContextSymbolsView = () => {
  const sessionData = useSessionContext();
  const isActive = sessionData.canUseMemoryOps;
  const sessionId = sessionData?.session?.id;

  const onNavigateToDisassembly = sessionData.onNavigateToDisassembly;
  const onNavigateToMemory = sessionData.onNavigateToMemory;
  const searchSymbols = sessionData.searchSymbols;

  const { contextMenu, openContextMenu, closeContextMenu } = useContextMenu<{ va: string; is_function: boolean }>();
  const [pendingBulk, setPendingBulk] = useState<PendingBulk | null>(null);

  const loadedCount = useMemo(
    () => (sessionData.symbolStatuses ?? []).filter((s) => hasUsableSymbols(s.status)).length,
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

  const fetchPreviews = useCallback(async (items: Symbol[]): Promise<(SymbolPreview | null)[]> => {
    if (!sessionId) return items.map(() => null);
    return invoke<(SymbolPreview | null)[]>('disassemble_preview_batch', {
      sessionId,
      addresses: items.map((s) => s.va),
    });
  }, [sessionId]);

  const applyBreakpoints = useCallback(async (bulk: PendingBulk) => {
    if (!sessionId || bulk.symbols.length === 0) return;
    try {
      // Group by the search term so the breakpoints can be enabled/removed as a unit;
      // fall back to a generic name if the term is empty (unlikely — search needs 2+ chars).
      const group = bulk.term || 'Symbols';
      await invokeSetBreakpoints(sessionId, bulk.symbols.map((s) => s.va), group, bulk.singleShot);
      bulk.clear();
    } catch (e) {
      console.error('Failed to set breakpoints:', e);
    }
  }, [sessionId]);

  const setBreakpointsForSymbols = useCallback((symbols: Symbol[], term: string, clear: () => void, singleShot: boolean) => {
    if (!sessionId || symbols.length === 0) return;
    const bulk = { symbols, term, clear, singleShot };
    if (symbols.length > BULK_CONFIRM_THRESHOLD) {
      setPendingBulk(bulk);
      return;
    }
    applyBreakpoints(bulk);
  }, [sessionId, applyBreakpoints]);

  return (
    <>
      <SymbolSearchView<Symbol>
        searchSymbols={searchSymbols}
        enabled={!!sessionId && isActive}
        placeholder={isActive ? "Search symbols..." : "Open, attach to, or run a process to search symbols"}
        columnWidthsKey="symbolsView.columnWidths"
        historyKey="symbol-search"
        idleTitle={isActive ? `Symbols for ${loadedCount} module${loadedCount === 1 ? '' : 's'} are loaded` : undefined}
        onSelect={onSelect}
        onRowContextMenu={(e, symbol) => openContextMenu(e, { va: symbol.va, is_function: symbol.is_function })}
        resetKey={sessionId}
        focusTabId="symbols"
        fetchPreviews={fetchPreviews}
        selectable
        renderBulkBar={(selectedSymbols, { term, clear }) => (
          <div className="flex items-center gap-1.5">
            <Button
              size="xs"
              disabled={selectedSymbols.length === 0}
              onClick={() => setBreakpointsForSymbols(selectedSymbols, term, clear, false)}
            >
              Set Breakpoints{selectedSymbols.length > 0 ? ` (${selectedSymbols.length})` : ''}
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={selectedSymbols.length === 0}
              onClick={() => setBreakpointsForSymbols(selectedSymbols, term, clear, true)}
            >
              Set Single-Shot{selectedSymbols.length > 0 ? ` (${selectedSymbols.length})` : ''}
            </Button>
          </div>
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

      <Dialog open={pendingBulk !== null} onOpenChange={(isOpen) => { if (!isOpen) setPendingBulk(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Set {pendingBulk?.symbols.length.toLocaleString()} breakpoints?</DialogTitle>
            <DialogDescription>
              Arming this many breakpoints patches every target and will noticeably slow the
              debuggee. They are grouped under &ldquo;{pendingBulk?.term || 'Symbols'}&rdquo;, so
              you can disable or remove them as a unit.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingBulk(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                const bulk = pendingBulk;
                setPendingBulk(null);
                if (bulk) applyBreakpoints(bulk);
              }}
            >
              Set {pendingBulk?.singleShot ? 'single-shot ' : ''}breakpoints
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};
