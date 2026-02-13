import { useEffect, useState, useCallback, useRef } from 'react';
import { useSessionContext } from '@/contexts/SessionContext';
import { useContextMenu } from '@/hooks/useContextMenu';
import { invokeToggleBreakpoint } from '@/lib/sessionHelpers';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Search, Code, Loader2 } from 'lucide-react';

export const ContextSymbolsView = () => {
  const sessionData = useSessionContext();
  const [searchTerm, setSearchTerm] = useState('');
  const [symbols, setSymbols] = useState<any[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const displayStatus = sessionData?.displayStatus;
  const isPaused = displayStatus === 'Paused';
  const sessionId = sessionData?.session?.id;

  const onNavigateToDisassembly = sessionData.onNavigateToDisassembly;
  const onNavigateToMemory = sessionData.onNavigateToMemory;

  const { contextMenu, contextMenuRef, openContextMenu, closeContextMenu } = useContextMenu<{ va: string; is_function: boolean }>();

  const toggleBreakpoint = useCallback(async (address: string) => {
    if (!sessionId) return;
    try {
      await invokeToggleBreakpoint(sessionId, address);
    } catch (e) {
      console.error('Failed to toggle breakpoint:', e);
    }
  }, [sessionId]);

  // Clear results when session changes or is not paused
  useEffect(() => {
    if (!sessionId || !isPaused) {
      setSymbols([]);
      setHasSearched(false);
      setIsSearching(false);
    }
  }, [sessionId, isPaused]);

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

    if (!sessionId || !isPaused || !sessionData.searchSymbols) return;

    setIsSearching(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const results = await sessionData.searchSymbols(trimmed, 30);
        setSymbols(results);
        setHasSearched(true);
      } catch (error) {
        console.error('Symbol search failed:', error);
        setSymbols([]);
        setHasSearched(true);
      }
      setIsSearching(false);
    }, 300);
  }, [sessionId, isPaused, sessionData.searchSymbols]);

  // Cleanup debounce on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const renderContent = () => {
    if (sessionData.session && !isPaused) {
      return (
        <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
          <div className="text-center">
            <Code className="h-12 w-12 mx-auto mb-4 opacity-50" />
            <p className="text-base font-medium">Symbol search unavailable</p>
            <p className="text-sm mt-1">Session must be paused to search symbols</p>
          </div>
        </div>
      );
    }

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
      <div className="space-y-1">
        {symbols.map((symbol, index) => (
          <div
            key={`${symbol.module_name}-${symbol.name}-${index}`}
            className="px-2 py-1 border-b hover:bg-gray-50 dark:hover:bg-gray-900 cursor-pointer"
            onClick={() => {
              if (symbol.is_function) {
                onNavigateToDisassembly?.(symbol.va);
              } else {
                onNavigateToMemory?.(symbol.va);
              }
            }}
            onContextMenu={(e) => openContextMenu(e, { va: symbol.va, is_function: symbol.is_function })}
          >
            <div className="flex-1 min-w-0">
              <p className="text-sm font-mono truncate">
                <span className="text-muted-foreground">{symbol.va}</span>
                <span className="ml-2">{symbol.display_name}</span>
              </p>
            </div>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="flex flex-col h-full">
      <div className="p-2 border-b">
        <Input
          type="text"
          placeholder={isPaused ? "Search symbols..." : "Session must be paused to search symbols"}
          value={searchTerm}
          onChange={handleSearchChange}
          className="w-full"
          disabled={!sessionId || !isPaused}
        />
      </div>
      <ScrollArea className="flex-1 min-h-0">
        {renderContent()}
      </ScrollArea>

      {/* Context Menu */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="fixed z-50 bg-popover text-popover-foreground rounded-md border shadow-md py-1 min-w-[180px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          {onNavigateToDisassembly && (
            <button
              className="w-full px-3 py-1.5 text-sm text-left hover:bg-accent hover:text-accent-foreground"
              onClick={() => {
                onNavigateToDisassembly(contextMenu.data.va);
                closeContextMenu();
              }}
            >
              Go to Disassembly
            </button>
          )}
          {onNavigateToMemory && (
            <button
              className="w-full px-3 py-1.5 text-sm text-left hover:bg-accent hover:text-accent-foreground"
              onClick={() => {
                onNavigateToMemory(contextMenu.data.va);
                closeContextMenu();
              }}
            >
              Go to Memory View
            </button>
          )}
          <button
            className="w-full px-3 py-1.5 text-sm text-left hover:bg-accent hover:text-accent-foreground"
            onClick={() => {
              toggleBreakpoint(contextMenu.data.va);
              closeContextMenu();
            }}
          >
            Toggle Breakpoint
          </button>
        </div>
      )}
    </div>
  );
};
