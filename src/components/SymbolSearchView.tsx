import { useState, useCallback, useRef, useEffect, ReactNode } from 'react';
import { Search, Code, Loader2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { DockPanel, PanelToolbar } from '@/components/ui/panel';
import { ScrollArea } from '@/components/ui/scroll-area';
import { VirtualizedList } from '@/components/ui/virtualized-list';
import { TruncatedSymbol } from '@/components/ui/truncated-symbol';
import { EmptyState } from '@/components/ui/empty-state';
import { usePanelFocus } from '@/hooks/usePanelFocus';

/** The fields every symbol source (session or PE file) returns per hit. */
export interface SymbolSearchItem {
  name: string;
  module_name: string;
  va: string;
  display_name: string;
  is_function: boolean;
}

export const MIN_SEARCH_CHARS = 2;
const SEARCH_LIMIT = 1000;
const DEBOUNCE_MS = 250;
const ROW_HEIGHT = 30;

interface SymbolSearchViewProps<T extends SymbolSearchItem> {
  searchSymbols: (pattern: string, limit: number) => Promise<T[]>;
  /** Whether searching is currently possible; the input is disabled otherwise. */
  enabled: boolean;
  placeholder: string;
  /** First idle-state line, e.g. what's loaded ("Symbols for 12 modules are loaded"). */
  idleTitle?: string;
  /** Second idle-state line; defaults to the start-typing hint. */
  idleSubtitle?: string;
  /** Address text shown before the symbol name; defaults to the raw VA string. */
  formatAddress?: (item: T) => string;
  onSelect: (item: T) => void;
  onRowContextMenu?: (e: React.MouseEvent, item: T) => void;
  /** Clears results whenever this changes (e.g. session id / file path). */
  resetKey?: unknown;
  /** Dock tab id — "Go to" that tab focuses the search input. Omit outside a dock tab. */
  focusTabId?: string;
  /** Extra content rendered inside the panel (e.g. a context menu). */
  children?: ReactNode;
}

/**
 * Debounced substring search over symbols with a virtualized result list.
 * Shared by the session Symbols tab and the PE viewer's Symbol Explorer — the
 * wrappers supply the data source, navigation, and any idle/context-menu extras.
 */
export function SymbolSearchView<T extends SymbolSearchItem>({
  searchSymbols, enabled, placeholder, idleTitle, idleSubtitle, formatAddress,
  onSelect, onRowContextMenu, resetKey, focusTabId, children,
}: SymbolSearchViewProps<T>) {
  const focusRef = usePanelFocus<HTMLInputElement>(focusTabId);
  const [term, setTerm] = useState('');
  const [symbols, setSymbols] = useState<T[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (debounceRef.current) clearTimeout(debounceRef.current); }, []);

  // Clear everything when the underlying source changes or goes away.
  // (On mount this just re-sets the initial values — harmless.)
  useEffect(() => {
    setTerm('');
    setSymbols([]);
    setSearched(false);
    setSearching(false);
  }, [resetKey]);

  const onChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setTerm(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const trimmed = value.trim();
    if (trimmed.length < MIN_SEARCH_CHARS) {
      setSymbols([]);
      setSearched(false);
      setSearching(false);
      return;
    }
    setSearching(true);
    debounceRef.current = setTimeout(async () => {
      try {
        setSymbols(await searchSymbols(trimmed, SEARCH_LIMIT));
      } catch (error) {
        console.error('Symbol search failed:', error);
        setSymbols([]);
      }
      setSearched(true);
      setSearching(false);
    }, DEBOUNCE_MS);
  }, [searchSymbols]);

  const showList = searched && !searching && symbols.length > 0;

  const stateContent = () => {
    if (searching) {
      return <EmptyState icon={<Loader2 className="h-8 w-8 mx-auto mb-4 animate-spin" />} title="Searching symbols..." />;
    }
    if (!searched) {
      return (
        <EmptyState
          icon={<Search className="h-12 w-12 mx-auto mb-4 opacity-50" />}
          title={idleTitle ?? 'Search symbols'}
          subtitle={idleSubtitle ?? `Start typing to search symbols — enter at least ${MIN_SEARCH_CHARS} characters`}
        />
      );
    }
    return (
      <EmptyState
        icon={<Code className="h-12 w-12 mx-auto mb-4 opacity-50" />}
        title="No symbols found"
        subtitle="Try different search terms"
      />
    );
  };

  return (
    <DockPanel>
      <PanelToolbar stack>
        <Input
          ref={focusRef}
          inputSize="xs"
          className="w-full"
          placeholder={placeholder}
          value={term}
          onChange={onChange}
          disabled={!enabled}
        />
        {showList && (
          <p className="text-xs text-muted-foreground">{symbols.length} symbols found</p>
        )}
      </PanelToolbar>
      <div className="flex-1 min-h-0">
        {showList ? (
          <VirtualizedList
            items={symbols}
            rowHeight={ROW_HEIGHT}
            className="h-full"
            getItemKey={(s, i) => `${s.module_name}-${s.name}-${i}`}
            renderItem={(s) => (
              <div
                className="px-2 py-1 border-b hover:bg-muted/40 cursor-pointer h-full"
                onClick={() => onSelect(s)}
                onContextMenu={onRowContextMenu ? (e) => onRowContextMenu(e, s) : undefined}
              >
                <div className="flex items-center gap-2 text-sm font-mono min-w-0 h-full">
                  <span className="text-muted-foreground shrink-0">{formatAddress ? formatAddress(s) : s.va}</span>
                  <TruncatedSymbol text={s.display_name} className="flex-1" />
                </div>
              </div>
            )}
          />
        ) : (
          <ScrollArea className="h-full">{stateContent()}</ScrollArea>
        )}
      </div>
      {children}
    </DockPanel>
  );
}
