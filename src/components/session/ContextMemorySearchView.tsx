import { useEffect, useState, useCallback, useRef } from 'react';
import { Virtualizer } from '@tanstack/react-virtual';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useSessionContext } from '@/contexts/SessionContext';
import { formatTauriError, isTargetLive } from '@/lib/sessionHelpers';
import { formatBytesAsHex } from '@/lib/hexUtils';
import { useContextMenu } from '@/hooks/useContextMenu';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { VirtualizedList } from '@/components/ui/virtualized-list';
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

const SearchResultRow = ({
  address,
  preview,
  onMissingPreview,
  onClick,
  onContextMenu,
}: {
  address: string;
  preview: string | null | undefined;
  onMissingPreview: () => void;
  onClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) => {
  // Rows scrolled into view have no preview yet; ask for a (debounced) fetch.
  const missing = preview === undefined;
  useEffect(() => {
    if (missing) onMissingPreview();
  }, [missing, onMissingPreview]);

  return (
    <div
      className="w-full h-full px-2 py-0.5 hover:bg-gray-50 dark:hover:bg-gray-900 cursor-pointer font-mono text-sm flex items-center"
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      <span className="w-[170px] shrink-0">{address}</span>
      <span className="flex-1 truncate text-muted-foreground">
        {preview === null ? '<unreadable>' : preview ?? ''}
      </span>
    </div>
  );
};

export const ContextMemorySearchView = () => {
  const sessionData = useSessionContext();
  const [searchTerm, setSearchTerm] = useState('');
  const [searchMode, setSearchMode] = useState<SearchMode>('hex');
  const [addresses, setAddresses] = useState<string[]>([]);
  const [capped, setCapped] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Hex byte previews per result address, for the rows currently on screen.
  // null = address became unreadable.
  const [previews, setPreviews] = useState<Map<string, string | null>>(new Map());

  const canUse = sessionData.canUseMemoryOps;
  const sessionId = sessionData?.session?.id;
  const isLive = isTargetLive(sessionData.displayStatus);

  const virtualizerRef = useRef<Virtualizer<HTMLDivElement, Element> | null>(null);
  const addressesRef = useRef<string[]>([]);
  addressesRef.current = addresses;
  // Bytes shown per row: the matched pattern, with a floor/cap to stay readable.
  const previewLenRef = useRef(8);
  const fetchInFlightRef = useRef(false);

  // Fetch byte previews for the rows currently rendered by the virtualizer.
  const fetchPreviews = useCallback(async () => {
    if (!sessionId || fetchInFlightRef.current) return;
    const all = addressesRef.current;
    if (all.length === 0) return;
    const virtualizer = virtualizerRef.current;
    const visible = virtualizer
      ? virtualizer.getVirtualItems().map((row) => all[row.index]).filter(Boolean)
      : all.slice(0, 64);
    if (visible.length === 0) return;

    fetchInFlightRef.current = true;
    try {
      const data = await invoke<(number[] | null)[]>('read_memory_batch', {
        sessionId,
        addresses: visible,
        size: previewLenRef.current,
      });
      setPreviews((prev) => {
        // Bail out when nothing changed so the 500ms live poll doesn't re-render
        // the whole result list with identical previews.
        let changed = false;
        const next = new Map(prev);
        visible.forEach((addr, i) => {
          const bytes = data[i];
          const value = bytes ? formatBytesAsHex(new Uint8Array(bytes)) : null;
          if (!next.has(addr) || next.get(addr) !== value) {
            next.set(addr, value);
            changed = true;
          }
        });
        return changed ? next : prev;
      });
    } catch {
      // Background preview read; keep last known bytes on failure.
    } finally {
      fetchInFlightRef.current = false;
    }
  }, [sessionId]);

  // Debounced fetch for rows scrolled into view that have no preview yet.
  const scheduleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const schedulePreviewFetch = useCallback(() => {
    if (scheduleTimerRef.current) return;
    scheduleTimerRef.current = setTimeout(() => {
      scheduleTimerRef.current = null;
      fetchPreviews();
    }, 100);
  }, [fetchPreviews]);
  useEffect(() => () => {
    if (scheduleTimerRef.current) clearTimeout(scheduleTimerRef.current);
  }, []);

  // Fresh previews when results change; poll while the target runs live and
  // refresh after each step — same cadence as the memory window.
  useEffect(() => {
    setPreviews(new Map());
    if (addresses.length > 0) fetchPreviews();
  }, [addresses, fetchPreviews]);

  useEffect(() => {
    if (!sessionId || !isLive) return;
    const interval = setInterval(() => {
      if (addressesRef.current.length > 0) fetchPreviews();
    }, 500);
    return () => clearInterval(interval);
  }, [sessionId, isLive, fetchPreviews]);

  useEffect(() => {
    if (sessionData.displayStatus === 'Paused' && addressesRef.current.length > 0) fetchPreviews();
  }, [sessionData.displayStatus, sessionData.session?.current_event, fetchPreviews]);

  const onNavigateToDisassembly = sessionData.onNavigateToDisassembly;
  const onNavigateToMemory = sessionData.onNavigateToMemory;
  const { addBookmark } = sessionData.bookmarkState;

  const { contextMenu, contextMenuRef, openContextMenu, closeContextMenu } = useContextMenu<{ address: string }>();

  // Clear results when session changes or no process is available
  useEffect(() => {
    if (!sessionId || !canUse) {
      setAddresses([]);
      setCapped(false);
      setHasSearched(false);
      setIsSearching(false);
      setError(null);
      setPreviews(new Map());
    }
  }, [sessionId, canUse]);

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
    if (!sessionId || !canUse) return;

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
    previewLenRef.current = Math.min(Math.max(pattern.length, 8), 16);

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
  }, [sessionId, canUse, searchTerm, searchMode]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSearch();
    }
  }, [handleSearch]);

  const renderContent = () => {
    if (sessionData.session && !canUse) {
      return (
        <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
          <div className="text-center">
            <HardDrive className="h-12 w-12 mx-auto mb-4 opacity-50" />
            <p className="text-base font-medium">Memory search unavailable</p>
            <p className="text-sm mt-1">Open or run a process to search memory</p>
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
      <VirtualizedList
        items={addresses}
        rowHeight={28}
        className="h-full"
        virtualizerRef={virtualizerRef}
        renderItem={(address) => (
          <SearchResultRow
            address={address}
            preview={previews.get(address)}
            onMissingPreview={schedulePreviewFetch}
            onClick={() => onNavigateToMemory?.(address)}
            onContextMenu={(e) => openContextMenu(e, { address })}
          />
        )}
      />
    );
  };

  return (
    <div className="flex flex-col h-full">
      <div className="p-2 border-b space-y-1">
        <div className="flex gap-1">
          <Input
            type="text"
            placeholder={
              !canUse
                ? 'No process open'
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
            disabled={!sessionId || !canUse}
          />
          <Button
            size="sm"
            variant="outline"
            onClick={handleSearch}
            disabled={!sessionId || !canUse || isSearching || searchTerm.trim().length === 0}
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
          <button
            className="w-full px-3 py-1.5 text-sm text-left hover:bg-accent hover:text-accent-foreground"
            onClick={() => {
              addBookmark({ kind: 'value', address: contextMenu.data.address, valueType: 'U32' });
              closeContextMenu();
            }}
          >
            Add to Bookmarks
          </button>
        </div>
      )}
    </div>
  );
};
