import { useEffect, useState, useCallback, useRef } from 'react';
import { useSessionContext } from '@/contexts/SessionContext';
import { useContextMenu } from '@/hooks/useContextMenu';
import { invokeToggleBreakpoint } from '@/lib/sessionHelpers';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { VirtualizedList } from '@/components/ui/virtualized-list';
import { DockPanel, PanelToolbar } from '@/components/ui/panel';
import { ContextMenu, ContextMenuItem } from '@/components/ui/context-menu';
import { TruncatedSymbol } from '@/components/ui/truncated-symbol';
import { Search, Code, Loader2 } from 'lucide-react';

export const ContextSymbolsView = () => {
  const sessionData = useSessionContext();
  const [searchTerm, setSearchTerm] = useState('');
  const [symbols, setSymbols] = useState<any[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isActive = sessionData.canUseMemoryOps;
  const sessionId = sessionData?.session?.id;

  const onNavigateToDisassembly = sessionData.onNavigateToDisassembly;
  const onNavigateToMemory = sessionData.onNavigateToMemory;

  const { contextMenu, openContextMenu, closeContextMenu } = useContextMenu<{ va: string; is_function: boolean }>();

  const toggleBreakpoint = useCallback(async (address: string) => {
    if (!sessionId) return;
    try {
      await invokeToggleBreakpoint(sessionId, address);
    } catch (e) {
      console.error('Failed to toggle breakpoint:', e);
    }
  }, [sessionId]);

  // Clear results when session ends
  useEffect(() => {
    if (!sessionId) {
      setSymbols([]);
      setHasSearched(false);
      setIsSearching(false);
    }
  }, [sessionId]);

  // Debounced search using searchSymbols from context
  const handleSearchChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setSearchTerm(value);

    if (debounceRef.current) clearTimeout(debounceRef.current);

    const trimmed = value.trim();
    if (trimmed.length < 2) {
      setSymbols([]);
      setHasSearched(false);
      setIsSearching(false);
      return;
    }

    if (!sessionId || !isActive || !sessionData.searchSymbols) return;

    setIsSearching(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const results = await sessionData.searchSymbols(trimmed, 1000);
        setSymbols(results);
        setHasSearched(true);
      } catch (error) {
        console.error('Symbol search failed:', error);
        setSymbols([]);
        setHasSearched(true);
      }
      setIsSearching(false);
    }, 300);
  }, [sessionId, isActive, sessionData.searchSymbols]);

  // Cleanup debounce on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const renderContent = () => {
    if (isSearching) {
      return (
        <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
          <Loader2 className="h-8 w-8 mx-auto mb-4 animate-spin" />
          <p className="text-sm">Searching symbols...</p>
        </div>
      );
    }

    if (!hasSearched) {
      return (
        <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
          <div className="text-center">
            <Search className="h-12 w-12 mx-auto mb-4 opacity-50" />
            <p className="text-base font-medium">Start typing to search symbols</p>
            <p className="text-sm mt-1">Enter at least 2 characters to begin search</p>
          </div>
        </div>
      );
    }

    if (symbols.length === 0) {
      return (
        <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
          <div className="text-center">
            <Code className="h-12 w-12 mx-auto mb-4 opacity-50" />
            <p className="text-base font-medium">No symbols found</p>
            <p className="text-sm mt-1">Try different search terms</p>
          </div>
        </div>
      );
    }

    return (
      <VirtualizedList
        items={symbols}
        rowHeight={32}
        className="h-full"
        getItemKey={(symbol, index) => `${symbol.module_name}-${symbol.name}-${index}`}
        renderItem={(symbol) => (
          <div
            className="px-2 py-1 border-b hover:bg-gray-50 dark:hover:bg-gray-900 cursor-pointer h-full"
            onClick={() => {
              if (symbol.is_function) {
                onNavigateToDisassembly?.(symbol.va);
              } else {
                onNavigateToMemory?.(symbol.va);
              }
            }}
            onContextMenu={(e) => openContextMenu(e, { va: symbol.va, is_function: symbol.is_function })}
          >
            <div className="flex items-center gap-2 text-sm font-mono min-w-0 h-full">
              <span className="text-muted-foreground shrink-0">{symbol.va}</span>
              <TruncatedSymbol text={symbol.display_name} className="flex-1" />
            </div>
          </div>
        )}
      />
    );
  };

  return (
    <DockPanel>
      <PanelToolbar stack>
        <Input
          type="text"
          inputSize="xs"
          placeholder={isActive ? "Search symbols..." : "Open, attach to, or run a process to search symbols"}
          value={searchTerm}
          onChange={handleSearchChange}
          className="w-full"
          disabled={!sessionId || !isActive}
        />
        {hasSearched && !isSearching && symbols.length > 0 && (
          <p className="text-xs text-muted-foreground">{symbols.length} symbols found</p>
        )}
      </PanelToolbar>
      <div className="flex-1 min-h-0">
        {symbols.length > 0 && hasSearched && !isSearching ? renderContent() : (
          <ScrollArea className="h-full">
            {renderContent()}
          </ScrollArea>
        )}
      </div>

      {/* Context Menu */}
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
    </DockPanel>
  );
};
