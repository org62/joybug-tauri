import { useEffect, useState, useCallback } from 'react';
import { useSessionContext } from '@/contexts/SessionContext';
import { Input } from '@/components/ui/input';
import { Search, Code, Loader2 } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export const ContextSymbolsView = () => {
  const sessionData = useSessionContext();
  const [searchTerm, setSearchTerm] = useState('');
  const [symbols, setSymbols] = useState<any[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);

  // Listen for symbol search results
  useEffect(() => {
    if (!sessionData.session?.id) return;

    const listenToSymbolUpdates = async () => {
      const unlistenUpdated = await listen<{session_id: string, pattern: string, symbols: any[]}>(
        "symbols-updated",
        (event) => {
          if (event.payload.session_id === sessionData.session?.id) {
            setSymbols(event.payload.symbols);
            setHasSearched(true);
            setIsSearching(false);
          }
        }
      );

      const unlistenError = await listen<{session_id: string, pattern: string, error: string}>(
        "symbols-error",
        (event) => {
          if (event.payload.session_id === sessionData.session?.id) {
            console.error('Symbol search failed:', event.payload.error);
            setSymbols([]);
            setHasSearched(true);
            setIsSearching(false);
          }
        }
      );

      return () => {
        unlistenUpdated();
        unlistenError();
      };
    };

    listenToSymbolUpdates();
  }, [sessionData.session?.id]);

  // Debounced search function
  const debouncedSearch = useCallback(
    (() => {
      let timeoutId: NodeJS.Timeout;
      return (pattern: string) => {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(async () => {
          if (!sessionData.session?.id) return;
          
          // Only allow symbol search when session is paused
          if (sessionData.session.status !== "Paused") {
            console.log("Cannot search symbols: session is not paused");
            setSymbols([]);
            setHasSearched(true);
            setIsSearching(false);
            return;
          }
          
          if (pattern.trim().length >= 2) {
            setIsSearching(true);
            try {
              await invoke("search_session_symbols", { 
                sessionId: sessionData.session.id, 
                pattern, 
                limit: 30 
              });
              // Results will come through the event listener
            } catch (error) {
              console.error('Failed to request symbol search:', error);
              setSymbols([]);
              setHasSearched(true);
              setIsSearching(false);
            }
          } else {
            setSymbols([]);
            setHasSearched(false);
          }
        }, 300); // 300ms debounce
      };
    })(),
    [sessionData.session?.id, sessionData.session?.status] // Add status to dependencies
  );

  // Handle search term changes
  useEffect(() => {
    debouncedSearch(searchTerm);
  }, [searchTerm, debouncedSearch]);

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchTerm(e.target.value);
  };

  const renderContent = () => {
    // Show a message when session is not in the right state
    if (sessionData.session && sessionData.session.status !== "Paused") {
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
            className="px-2 py-1 border-b hover:bg-gray-50 dark:hover:bg-gray-900"
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
          placeholder={sessionData.session?.status === "Paused" ? "Search symbols..." : "Session must be paused to search symbols"}
          value={searchTerm}
          onChange={handleSearchChange}
          className="w-full"
          disabled={!sessionData.session || sessionData.session.status !== "Paused"}
        />
      </div>
      <div className="flex-1 overflow-auto">
        {renderContent()}
      </div>
    </div>
  );
}; 