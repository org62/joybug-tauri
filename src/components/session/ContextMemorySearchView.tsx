import { useEffect, useState, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useSessionContext } from '@/contexts/SessionContext';
import { formatTauriError, isTargetLive } from '@/lib/sessionHelpers';
import { formatBytesAsHex } from '@/lib/hexUtils';
import { cn, CHANGED_VALUE_CLASS } from '@/lib/utils';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { useVisibleRowsFetch } from '@/hooks/useVisibleRowsFetch';
import { useContextMenu } from '@/hooks/useContextMenu';
import { usePanelFocus } from '@/hooks/usePanelFocus';
import { HistoryInput } from '@/components/ui/history-input';
import { pushInputHistory } from '@/lib/inputHistory';
import { Button } from '@/components/ui/button';
import { DockPanel, PanelToolbar } from '@/components/ui/panel';
import { ContextMenu, ContextMenuItem } from '@/components/ui/context-menu';
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
  changed,
  onMissingPreview,
  onClick,
  onContextMenu,
}: {
  address: string;
  preview: string | null | undefined;
  changed: boolean;
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
      <span
        data-changed={changed || undefined}
        className={cn("flex-1 truncate", changed ? CHANGED_VALUE_CLASS : "text-muted-foreground")}
      >
        {preview === null ? '<unreadable>' : preview ?? ''}
      </span>
    </div>
  );
};

export const ContextMemorySearchView = () => {
  const sessionData = useSessionContext();
  const focusRef = usePanelFocus<HTMLInputElement>('memory_search');
  const [searchTerm, setSearchTerm] = useState('');
  const [searchMode, setSearchMode] = useState<SearchMode>('hex');
  const [addresses, setAddresses] = useState<string[]>([]);
  const [capped, setCapped] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Hex byte previews per result address, for the rows currently on screen
  // (null = address became unreadable), plus the addresses whose preview
  // differs from the previous read (red highlight). One state so the previous
  // previews double as the change-detection baseline.
  const [previewState, setPreviewState] = useState<{
    previews: Map<string, string | null>;
    changed: Set<string>;
  }>({ previews: new Map(), changed: new Set() });

  const canUse = sessionData.canUseMemoryOps;
  const sessionId = sessionData?.session?.id;
  const isLive = isTargetLive(sessionData.displayStatus);

  // Bytes shown per row: the matched pattern, with a floor/cap to stay readable.
  const previewLenRef = useRef(8);

  // Fetch byte previews for the rows currently rendered by the virtualizer.
  const fetchVisible = useCallback(async (visible: string[]) => {
    if (!sessionId) return false;
    const data = await invoke<(number[] | null)[]>('read_memory_batch', {
      sessionId,
      addresses: visible,
      size: previewLenRef.current,
    });
    const values = visible.map((_, i) =>
      data[i] ? formatBytesAsHex(new Uint8Array(data[i]!)) : null,
    );
    // The previous previews are the change baseline: a refreshed address that
    // differs turns red; identical again → cleared. Addresses first seen this
    // fetch don't flash. Bail out when nothing changed so the 500ms live poll
    // doesn't re-render the whole result list with identical previews.
    setPreviewState((prev) => {
      let mutated = false;
      const previews = new Map(prev.previews);
      const changed = new Set(prev.changed);
      visible.forEach((addr, i) => {
        const value = values[i];
        const had = prev.previews.has(addr);
        if (!had || prev.previews.get(addr) !== value) {
          previews.set(addr, value);
          mutated = true;
        }
        const isChanged = had && prev.previews.get(addr) !== value;
        if (isChanged && !changed.has(addr)) { changed.add(addr); mutated = true; }
        else if (!isChanged && changed.has(addr)) { changed.delete(addr); mutated = true; }
      });
      return mutated ? { previews, changed } : prev;
    });
  }, [sessionId]);
  // No followUp: the live poll below re-fetches all visible rows anyway.
  const { virtualizerRef, schedule: schedulePreviewFetch, fetchNow: fetchPreviews } =
    useVisibleRowsFetch({ items: addresses, fetchVisible });

  // Fresh previews when results change (new baseline — a fresh search doesn't
  // flash red); poll while the target runs live and refresh after each step —
  // same cadence as the memory window.
  useEffect(() => {
    setPreviewState({ previews: new Map(), changed: new Set() });
    if (addresses.length > 0) fetchPreviews();
  }, [addresses, fetchPreviews]);

  useLiveRefresh(sessionId, isLive, () => {
    fetchPreviews();
  });

  const onNavigateToDisassembly = sessionData.onNavigateToDisassembly;
  const onNavigateToMemory = sessionData.onNavigateToMemory;
  const { addBookmark } = sessionData.bookmarkState;

  const { contextMenu, openContextMenu, closeContextMenu } = useContextMenu<{ address: string }>();

  // Clear results when session changes or no process is available
  useEffect(() => {
    if (!sessionId || !canUse) {
      setAddresses([]);
      setCapped(false);
      setHasSearched(false);
      setIsSearching(false);
      setError(null);
      setPreviewState({ previews: new Map(), changed: new Set() });
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

    pushInputHistory(`memsearch-${searchMode}`, trimmed);
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
            preview={previewState.previews.get(address)}
            changed={previewState.changed.has(address)}
            onMissingPreview={schedulePreviewFetch}
            onClick={() => onNavigateToMemory?.(address)}
            onContextMenu={(e) => openContextMenu(e, { address })}
          />
        )}
      />
    );
  };

  return (
    <DockPanel>
      <PanelToolbar stack>
        <div className="flex gap-1">
          <HistoryInput
            historyKey={`memsearch-${searchMode}`}
            ref={focusRef}
            type="text"
            inputSize="xs"
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
            size="icon-xs"
            variant="outline"
            onClick={handleSearch}
            disabled={!sessionId || !canUse || isSearching || searchTerm.trim().length === 0}
          >
            <Search />
          </Button>
        </div>
        <div className="flex items-center gap-1 text-xs">
          {(['hex', 'ascii', 'utf16'] as const).map((mode) => (
            <Button
              key={mode}
              size="xs"
              variant={searchMode === mode ? 'default' : 'ghost'}
              onClick={() => setSearchMode(mode)}
            >
              {mode === 'hex' ? 'Hex' : mode === 'ascii' ? 'ASCII' : 'UTF-16'}
            </Button>
          ))}
          {hasSearched && addresses.length > 0 && (
            <span className="ml-auto text-muted-foreground">
              {addresses.length.toLocaleString()} result{addresses.length !== 1 ? 's' : ''}
              {capped && (
                <span className="text-syn-state ml-1" title="Results were capped at the limit">
                  (capped)
                </span>
              )}
            </span>
          )}
        </div>
      </PanelToolbar>
      <div className="flex-1 min-h-0">
        {renderContent()}
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <ContextMenu x={contextMenu.x} y={contextMenu.y} onClose={closeContextMenu} className="min-w-[180px]">
          {onNavigateToDisassembly && (
            <ContextMenuItem onClick={() => onNavigateToDisassembly(contextMenu.data.address)}>
              Go to Disassembly
            </ContextMenuItem>
          )}
          {onNavigateToMemory && (
            <ContextMenuItem onClick={() => onNavigateToMemory(contextMenu.data.address)}>
              Go to Memory View
            </ContextMenuItem>
          )}
          <ContextMenuItem
            onClick={() => addBookmark({ kind: 'value', address: contextMenu.data.address, valueType: 'U32' })}
          >
            Add to Bookmarks
          </ContextMenuItem>
        </ContextMenu>
      )}
    </DockPanel>
  );
};
