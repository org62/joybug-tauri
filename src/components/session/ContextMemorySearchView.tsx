import { useEffect, useState, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useSessionContext } from '@/contexts/SessionContext';
import { formatTauriError } from '@/lib/sessionHelpers';
import { useContextMenu } from '@/hooks/useContextMenu';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Search, HardDrive, Loader2, AlertTriangle } from 'lucide-react';

type SearchMode = 'hex' | 'ascii' | 'utf16';

function parseHexPattern(input: string): Uint8Array | null {
  const cleaned = input.replace(/\s+/g, '');
  if (cleaned.length === 0 || cleaned.length % 2 !== 0) return null;
  if (!/^[0-9a-fA-F]+$/.test(cleaned)) return null;
  const bytes = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < cleaned.length; i += 2) {
    bytes[i / 2] = parseInt(cleaned.substring(i, i + 2), 16);
  }
  return bytes;
}

function stringToAsciiBytes(input: string): Uint8Array {
  return new TextEncoder().encode(input);
}

function stringToUtf16Le(input: string): Uint8Array {
  const buf = new ArrayBuffer(input.length * 2);
  const view = new DataView(buf);
  for (let i = 0; i < input.length; i++) {
    view.setUint16(i * 2, input.charCodeAt(i), true);
  }
  return new Uint8Array(buf);
}

export const ContextMemorySearchView = () => {
  const sessionData = useSessionContext();
  const [searchTerm, setSearchTerm] = useState('');
  const [searchMode, setSearchMode] = useState<SearchMode>('hex');
  const [addresses, setAddresses] = useState<string[]>([]);
  const [capped, setCapped] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollParentRef = useRef<HTMLDivElement>(null);

  const displayStatus = sessionData?.displayStatus;
  const isPaused = displayStatus === 'Paused';
  const sessionId = sessionData?.session?.id;

  const onNavigateToDisassembly = sessionData.onNavigateToDisassembly;
  const onNavigateToMemory = sessionData.onNavigateToMemory;

  const { contextMenu, contextMenuRef, openContextMenu, closeContextMenu } = useContextMenu<{ address: string }>();

  // Clear results when session changes or is not paused
  useEffect(() => {
    if (!sessionId || !isPaused) {
      setAddresses([]);
      setCapped(false);
      setHasSearched(false);
      setIsSearching(false);
      setError(null);
    }
  }, [sessionId, isPaused]);

  // Listen for search results
  useEffect(() => {
    if (!sessionId) return;

    const unlistenResult = listen<{ session_id: string; addresses: string[]; capped: boolean }>(
      'memory-search-result',
      (event) => {
        if (event.payload.session_id !== sessionId) return;
        setAddresses(event.payload.addresses);
        setCapped(event.payload.capped);
        setHasSearched(true);
        setIsSearching(false);
        setError(null);
      }
    );

    const unlistenError = listen<{ session_id: string; error: string }>(
      'memory-search-error',
      (event) => {
        if (event.payload.session_id !== sessionId) return;
        setError(event.payload.error);
        setAddresses([]);
        setCapped(false);
        setHasSearched(true);
        setIsSearching(false);
      }
    );

    return () => {
      unlistenResult.then((f) => f());
      unlistenError.then((f) => f());
    };
  }, [sessionId]);

  const handleSearch = useCallback(async () => {
    if (!sessionId || !isPaused) return;

    const trimmed = searchTerm.trim();
    if (trimmed.length === 0) return;

    let pattern: number[];
    if (searchMode === 'hex') {
      const bytes = parseHexPattern(trimmed);
      if (!bytes) {
        setError('Invalid hex pattern. Use format: 48 8B 05 or 488B05');
        return;
      }
      pattern = Array.from(bytes);
    } else if (searchMode === 'utf16') {
      pattern = Array.from(stringToUtf16Le(trimmed));
    } else {
      pattern = Array.from(stringToAsciiBytes(trimmed));
    }

    setIsSearching(true);
    setError(null);
    setHasSearched(false);

    try {
      await invoke('request_memory_search', {
        sessionId,
        pattern,
        maxResults: 10000,
      });
    } catch (e) {
      setError(formatTauriError(e));
      setIsSearching(false);
    }
  }, [sessionId, isPaused, searchTerm, searchMode]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSearch();
    }
  }, [handleSearch]);

  const virtualizer = useVirtualizer({
    count: addresses.length,
    getScrollElement: () => scrollParentRef.current,
    estimateSize: () => 28,
    overscan: 20,
  });

  const renderContent = () => {
    if (sessionData.session && !isPaused) {
      return (
        <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
          <div className="text-center">
            <HardDrive className="h-12 w-12 mx-auto mb-4 opacity-50" />
            <p className="text-base font-medium">Memory search unavailable</p>
            <p className="text-sm mt-1">Session must be paused to search memory</p>
          </div>
        </div>
      );
    }

    if (isSearching) {
      return (
        <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
          <Loader2 className="h-8 w-8 mx-auto mb-4 animate-spin" />
          <p className="text-sm">Searching memory...</p>
        </div>
      );
    }

    if (error) {
      return (
        <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
          <div className="text-center">
            <AlertTriangle className="h-12 w-12 mx-auto mb-4 opacity-50 text-destructive" />
            <p className="text-base font-medium">Search failed</p>
            <p className="text-sm mt-1 text-destructive">{error}</p>
          </div>
        </div>
      );
    }

    if (!hasSearched) {
      return (
        <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
          <div className="text-center">
            <Search className="h-12 w-12 mx-auto mb-4 opacity-50" />
            <p className="text-base font-medium">Search process memory</p>
            <p className="text-sm mt-1">Enter a hex byte pattern or string and press Enter</p>
          </div>
        </div>
      );
    }

    if (addresses.length === 0) {
      return (
        <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
          <div className="text-center">
            <HardDrive className="h-12 w-12 mx-auto mb-4 opacity-50" />
            <p className="text-base font-medium">No results found</p>
            <p className="text-sm mt-1">Try a different search pattern</p>
          </div>
        </div>
      );
    }

    return (
      <div
        ref={scrollParentRef}
        className="h-full overflow-auto"
      >
        <div
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            width: '100%',
            position: 'relative',
          }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const address = addresses[virtualRow.index];
            return (
              <div
                key={virtualRow.key}
                className="absolute w-full px-2 py-0.5 hover:bg-gray-50 dark:hover:bg-gray-900 cursor-pointer font-mono text-sm"
                style={{
                  height: `${virtualRow.size}px`,
                  transform: `translateY(${virtualRow.start}px)`,
                }}
                onClick={() => onNavigateToMemory?.(address)}
                onContextMenu={(e) => openContextMenu(e, { address })}
              >
                {address}
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <div className="flex flex-col h-full">
      <div className="p-2 border-b space-y-1">
        <div className="flex gap-1">
          <Input
            type="text"
            placeholder={
              !isPaused
                ? 'Session must be paused'
                : searchMode === 'hex'
                ? 'Hex bytes: 48 8B 05 or 488B05'
                : searchMode === 'utf16'
                ? 'UTF-16 LE string...'
                : 'ASCII string...'
            }
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            onKeyDown={handleKeyDown}
            className="flex-1"
            disabled={!sessionId || !isPaused}
          />
          <Button
            size="sm"
            variant="outline"
            onClick={handleSearch}
            disabled={!sessionId || !isPaused || isSearching || searchTerm.trim().length === 0}
          >
            <Search className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <button
            className={`px-1.5 py-0.5 rounded ${searchMode === 'hex' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent'}`}
            onClick={() => setSearchMode('hex')}
          >
            Hex
          </button>
          <button
            className={`px-1.5 py-0.5 rounded ${searchMode === 'ascii' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent'}`}
            onClick={() => setSearchMode('ascii')}
          >
            ASCII
          </button>
          <button
            className={`px-1.5 py-0.5 rounded ${searchMode === 'utf16' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent'}`}
            onClick={() => setSearchMode('utf16')}
          >
            UTF-16
          </button>
          {hasSearched && addresses.length > 0 && (
            <span className="ml-auto text-muted-foreground">
              {addresses.length.toLocaleString()} result{addresses.length !== 1 ? 's' : ''}
              {capped && (
                <span className="text-yellow-500 ml-1" title="Results were capped at the limit">
                  (capped)
                </span>
              )}
            </span>
          )}
        </div>
      </div>
      <div className="flex-1 min-h-0">
        {addresses.length > 0 ? renderContent() : (
          <ScrollArea className="h-full">
            {renderContent()}
          </ScrollArea>
        )}
      </div>

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
                onNavigateToDisassembly(contextMenu.data.address);
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
                onNavigateToMemory(contextMenu.data.address);
                closeContextMenu();
              }}
            >
              Go to Memory View
            </button>
          )}
        </div>
      )}
    </div>
  );
};
