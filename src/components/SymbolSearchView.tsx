import { useState, useCallback, useRef, useEffect, useMemo, ReactNode } from 'react';
import { Search, Code, Loader2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { DockPanel, PanelToolbar } from '@/components/ui/panel';
import { ScrollArea } from '@/components/ui/scroll-area';
import { VirtualizedList } from '@/components/ui/virtualized-list';
import { TruncatedSymbol } from '@/components/ui/truncated-symbol';
import { EmptyState } from '@/components/ui/empty-state';
import { ResizableHeaderCell } from '@/components/ui/resizable-header-cell';
import { SortHeader } from '@/components/ui/sort-header';
import { usePanelFocus } from '@/hooks/usePanelFocus';
import { useVisibleRowsFetch } from '@/hooks/useVisibleRowsFetch';
import { useColumnWidths } from '@/hooks/useColumnWidths';
import { useHeaderScrollSync } from '@/hooks/useHeaderScrollSync';

/** The fields every symbol source (session or PE file) returns per hit. */
export interface SymbolSearchItem {
  name: string;
  module_name: string;
  va: string;
  display_name: string;
  is_function: boolean;
}

/** Per-row enrichment: the first instruction's bytes and disassembly at the symbol. */
export interface SymbolPreview {
  bytes: string;
  disasm: string;
}

export const MIN_SEARCH_CHARS = 2;
export const SEARCH_LIMIT = 10000;
const DEBOUNCE_MS = 250;
const ROW_HEIGHT = 30;
/** Checkbox gutter, and the row's own px-2 — both mirrored by the header. */
const CHECKBOX_COL = 24;
const ROW_PADDING = 16;
/** Width floor for the trailing flex column; below it the rows scroll horizontally. */
const FILLER_MIN = 200;

const DEFAULT_COLUMN_WIDTHS = { address: 150, symbol: 288, bytes: 160 };

/** Sortable columns; `null` keeps the backend's order (exact matches first). */
type SortKey = 'address' | 'symbol' | 'bytes' | 'disasm';

interface SymbolSearchViewProps<T extends SymbolSearchItem> {
  searchSymbols: (pattern: string, limit: number) => Promise<T[]>;
  /** Whether searching is currently possible; the input is disabled otherwise. */
  enabled: boolean;
  placeholder: string;
  /** localStorage key for the column widths (kept separate per host view). */
  columnWidthsKey: string;
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
  /**
   * Enables multi-select: a checkbox per row, a Select All / Clear strip, and shift-click
   * range selection. Single-click on a row still fires `onSelect` (navigation). Host
   * supplies the bulk action(s) via `renderBulkBar`.
   */
  selectable?: boolean;
  /**
   * Rendered in the selection strip (right side) when `selectable`. Receives the currently
   * selected items, the trimmed search term (for naming), and a `clear` callback.
   */
  renderBulkBar?: (selected: T[], ctx: { term: string; clear: () => void }) => ReactNode;
  /**
   * Fetches bytes/disasm previews for the given result rows (visible rows only —
   * called lazily as the list scrolls). Must return one entry per input item,
   * null where no preview is available. When omitted, the preview columns are
   * not rendered.
   */
  fetchPreviews?: (items: T[]) => Promise<(SymbolPreview | null)[]>;
  /** Extra content rendered inside the panel (e.g. a context menu). */
  children?: ReactNode;
}

/**
 * Debounced substring search over symbols with a virtualized result list.
 * Shared by the session Symbols tab and the PE viewer's Symbol Explorer — the
 * wrappers supply the data source, navigation, and any idle/context-menu extras.
 *
 * Columns are resizable (persisted per host) and sortable. Sorting reorders the
 * display only: selection is keyed by each symbol's index in the fetched result
 * set, so a Select All survives a re-sort.
 */
export function SymbolSearchView<T extends SymbolSearchItem>({
  searchSymbols, enabled, placeholder, columnWidthsKey, idleTitle, idleSubtitle, formatAddress,
  onSelect, onRowContextMenu, resetKey, focusTabId, selectable, renderBulkBar,
  fetchPreviews, children,
}: SymbolSearchViewProps<T>) {
  const focusRef = usePanelFocus<HTMLInputElement>(focusTabId);
  const [term, setTerm] = useState('');
  const [symbols, setSymbols] = useState<T[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { columnWidths, handleColumnResizeStart } = useColumnWidths(columnWidthsKey, DEFAULT_COLUMN_WIDTHS);

  // Without previews the symbol column is the trailing flex filler, so the
  // address is the only fixed column.
  const fixedColumnsPx = fetchPreviews
    ? columnWidths.address + columnWidths.symbol + columnWidths.bytes
    : columnWidths.address;
  const rowMinWidth = `${fixedColumnsPx + ROW_PADDING + (selectable ? CHECKBOX_COL : 0) + FILLER_MIN}px`;
  const { headerInnerRef, handleViewportScroll, handleHeaderScroll } = useHeaderScrollSync(rowMinWidth);

  // Bytes/disasm previews, fetched lazily for the rows the virtualizer renders,
  // keyed by VA. `null` marks "fetched, nothing there" so rows aren't re-requested.
  const [previews, setPreviews] = useState<Map<string, SymbolPreview | null>>(new Map());
  const previewsRef = useRef(previews);
  previewsRef.current = previews;

  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortAsc, setSortAsc] = useState(true);

  const toggleSort = useCallback((key: SortKey) => {
    setSortAsc((prev) => (sortKey === key ? !prev : true));
    setSortKey(key);
  }, [sortKey]);

  // Only the preview columns read the (streaming) preview map, so the other
  // sorts don't re-run on every enrichment batch.
  const previewSort = sortKey === 'bytes' || sortKey === 'disasm';
  const previewsForSort = previewSort ? previews : null;

  // Display order. Each row keeps `i`, its index in the fetched `symbols` array,
  // which is what selection is keyed on — re-sorting never invalidates it.
  const rows = useMemo(() => {
    const base = symbols.map((s, i) => ({ s, i }));
    if (!sortKey) return base;
    const dir = sortAsc ? 1 : -1;
    // Case-folded once per symbol rather than per comparison: at the 10k limit
    // the sort makes ~10^5 comparisons. Plain code-unit order (not
    // localeCompare) keeps identifier-ish names ordered the obvious way.
    const nameKeys = sortKey === 'symbol'
      ? symbols.map((s) => s.display_name.toLowerCase())
      : null;
    const previewField = sortKey === 'bytes' ? 'bytes' : 'disasm';
    base.sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'address') {
        const av = BigInt(a.s.va);
        const bv = BigInt(b.s.va);
        cmp = av < bv ? -1 : av > bv ? 1 : 0;
      } else if (nameKeys) {
        const av = nameKeys[a.i];
        const bv = nameKeys[b.i];
        cmp = av < bv ? -1 : av > bv ? 1 : 0;
      } else {
        const av = previewsForSort?.get(a.s.va)?.[previewField];
        const bv = previewsForSort?.get(b.s.va)?.[previewField];
        // Previews only exist for rows that have been scrolled into view, so
        // rows without one sink to the bottom in both directions.
        if (!av && !bv) cmp = 0;
        else if (!av) return 1;
        else if (!bv) return -1;
        else cmp = av < bv ? -1 : av > bv ? 1 : 0;
      }
      // Stable: equal keys keep the backend's order.
      return cmp !== 0 ? cmp * dir : a.i - b.i;
    });
    return base;
  }, [symbols, sortKey, sortAsc, previewsForSort]);

  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  // Same order as the list's items, so the virtualizer's indices line up.
  const rowItems = useMemo(() => rows.map((r) => r.s), [rows]);

  const fetchVisible = useCallback(async (visible: T[]) => {
    if (!fetchPreviews) return false;
    const missing = visible.filter((s) => !previewsRef.current.has(s.va));
    if (missing.length === 0) return false;
    const data = await fetchPreviews(missing);
    setPreviews((prev) => {
      const next = new Map(prev);
      missing.forEach((s, i) => next.set(s.va, data[i] ?? null));
      return next;
    });
  }, [fetchPreviews]);
  // followUp: previews are fetched once per row, so the extra pass (catching
  // rows scrolled in mid-fetch) converges as soon as nothing is missing.
  const { virtualizerRef, schedule: schedulePreviewFetch } =
    useVisibleRowsFetch({ items: rowItems, fetchVisible, followUp: true });

  // New result set: previews belong to the old rows — drop them. Re-sorting
  // doesn't, since previews are keyed by VA and so are order-independent.
  useEffect(() => { setPreviews(new Map()); }, [symbols]);
  // Whatever is on screen now needs previews — after a search or a re-sort.
  useEffect(() => {
    if (rows.length > 0) schedulePreviewFetch();
  }, [rows, schedulePreviewFetch]);

  // Selection state, holding indices into the fetched `symbols` array (not display
  // positions). `anchorRef` is the last toggled *display* position, used as the
  // pivot for shift-click range selection.
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const anchorRef = useRef<number | null>(null);

  const clearSelection = useCallback(() => {
    setSelected(new Set());
    anchorRef.current = null;
  }, []);

  useEffect(() => () => { if (debounceRef.current) clearTimeout(debounceRef.current); }, []);

  // Clear everything when the underlying source changes or goes away.
  // (On mount this just re-sets the initial values — harmless.)
  useEffect(() => {
    setTerm('');
    setSymbols([]);
    setSearched(false);
    setSearching(false);
  }, [resetKey]);

  // A new result set (including the reset above clearing it) invalidates the selection.
  useEffect(() => { clearSelection(); }, [symbols, clearSelection]);
  // The anchor is a display position, so a re-sort makes it meaningless.
  useEffect(() => { anchorRef.current = null; }, [sortKey, sortAsc]);

  const toggleSelect = useCallback((displayIndex: number, shift: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const anchor = anchorRef.current;
      const current = rowsRef.current;
      if (shift && anchor !== null) {
        const [lo, hi] = anchor <= displayIndex ? [anchor, displayIndex] : [displayIndex, anchor];
        for (let k = lo; k <= hi; k++) {
          const row = current[k];
          if (row) next.add(row.i);
        }
      } else {
        const id = current[displayIndex]?.i;
        if (id === undefined) return prev;
        if (next.has(id)) next.delete(id);
        else next.add(id);
      }
      return next;
    });
    if (!shift) anchorRef.current = displayIndex;
  }, []);

  const selectAll = useCallback(() => {
    setSelected(new Set(symbols.map((_, i) => i)));
    anchorRef.current = null;
  }, [symbols]);

  const selectedItems = useMemo(
    () => Array.from(selected).sort((a, b) => a - b).map((i) => symbols[i]).filter(Boolean),
    [selected, symbols],
  );

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
  // The backend truncates at the limit in module order rather than ranking, so
  // a full result set means hits were dropped.
  const capped = symbols.length >= SEARCH_LIMIT;

  const onViewportScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    handleViewportScroll(e);
    if (fetchPreviews) schedulePreviewFetch();
  }, [handleViewportScroll, fetchPreviews, schedulePreviewFetch]);

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

  const symbolSortHeader = (
    <SortHeader label="Symbol" active={sortKey === 'symbol'} asc={sortAsc} onClick={() => toggleSort('symbol')} />
  );

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
        {showList && !selectable && (
          <p className="text-xs text-muted-foreground">
            {symbols.length.toLocaleString()} symbols found{capped ? ' (capped)' : ''}
          </p>
        )}
        {showList && selectable && (
          <div className="flex items-center gap-1.5">
            <Button size="xs" variant="ghost" onClick={selectAll}>Select All</Button>
            {selected.size > 0 && (
              <Button size="xs" variant="ghost" onClick={clearSelection}>Clear</Button>
            )}
            <span className="text-xs text-muted-foreground">
              {selected.size > 0
                ? `${selected.size.toLocaleString()} selected`
                : `${symbols.length.toLocaleString()} found${capped ? ' (capped)' : ''}`}
            </span>
            <span className="flex-1" />
            {renderBulkBar?.(selectedItems, { term: term.trim(), clear: clearSelection })}
          </div>
        )}
      </PanelToolbar>

      {/* Column header row — fixed vertically, follows the list's horizontal scroll */}
      {showList && (
        <div className="shrink-0 overflow-hidden border-b bg-muted/30" onScroll={handleHeaderScroll}>
          <div
            ref={headerInnerRef}
            data-testid="symbols-header"
            style={{ minWidth: rowMinWidth }}
            className="flex items-center px-2 py-1 text-xs font-medium text-muted-foreground select-none"
          >
            {selectable && <span className="shrink-0" style={{ width: CHECKBOX_COL }} />}
            <ResizableHeaderCell
              width={columnWidths.address}
              onResizeStart={(e) => handleColumnResizeStart('address', e)}
            >
              <SortHeader label="Address" active={sortKey === 'address'} asc={sortAsc}
                onClick={() => toggleSort('address')} />
            </ResizableHeaderCell>
            {fetchPreviews ? (
              <>
                <ResizableHeaderCell
                  width={columnWidths.symbol}
                  onResizeStart={(e) => handleColumnResizeStart('symbol', e)}
                >
                  {symbolSortHeader}
                </ResizableHeaderCell>
                <ResizableHeaderCell
                  width={columnWidths.bytes}
                  onResizeStart={(e) => handleColumnResizeStart('bytes', e)}
                >
                  <SortHeader label="Bytes" active={sortKey === 'bytes'} asc={sortAsc}
                    onClick={() => toggleSort('bytes')} />
                </ResizableHeaderCell>
                <span className="flex-1 min-w-0">
                  <SortHeader label="Disassembly" active={sortKey === 'disasm'} asc={sortAsc}
                    onClick={() => toggleSort('disasm')} />
                </span>
              </>
            ) : (
              <span className="flex-1 min-w-0">{symbolSortHeader}</span>
            )}
          </div>
        </div>
      )}

      <div className="flex-1 min-h-0">
        {showList ? (
          <VirtualizedList
            items={rows}
            rowHeight={ROW_HEIGHT}
            className="h-full"
            minContentWidth={rowMinWidth}
            virtualizerRef={virtualizerRef}
            onViewportScroll={onViewportScroll}
            getItemKey={(row) => `${row.s.module_name}-${row.s.name}-${row.i}`}
            renderItem={(row, displayIndex) => {
              const s = row.s;
              const preview = fetchPreviews ? previews.get(s.va) : undefined;
              return (
                <div
                  className="px-2 py-1 border-b hover:bg-muted/40 cursor-pointer h-full"
                  onClick={() => onSelect(s)}
                  onContextMenu={onRowContextMenu ? (e) => onRowContextMenu(e, s) : undefined}
                >
                  <div className="flex items-center text-sm font-mono h-full">
                    {selectable && (
                      <span
                        className="flex items-center shrink-0"
                        style={{ width: CHECKBOX_COL }}
                        onClick={(e) => { e.stopPropagation(); toggleSelect(displayIndex, e.shiftKey); }}
                      >
                        <Checkbox checked={selected.has(row.i)} tabIndex={-1} className="pointer-events-none" />
                      </span>
                    )}
                    <span
                      data-testid="symbol-address"
                      className="shrink-0 truncate pr-1 text-muted-foreground"
                      style={{ width: columnWidths.address }}
                    >
                      {formatAddress ? formatAddress(s) : s.va}
                    </span>
                    {fetchPreviews ? (
                      <>
                        <TruncatedSymbol
                          data-testid="symbol-name"
                          text={s.display_name}
                          className="shrink-0 pr-1"
                          style={{ width: columnWidths.symbol }}
                        />
                        <span
                          data-testid="symbol-preview-bytes"
                          className="shrink-0 truncate pr-1 text-xs text-muted-foreground"
                          style={{ width: columnWidths.bytes }}
                          title={preview?.bytes}
                        >
                          {preview?.bytes ?? ''}
                        </span>
                        <span
                          data-testid="symbol-preview-disasm"
                          className="flex-1 min-w-0 truncate"
                          title={preview?.disasm}
                        >
                          {preview?.disasm ?? ''}
                        </span>
                      </>
                    ) : (
                      <TruncatedSymbol data-testid="symbol-name" text={s.display_name} className="flex-1 min-w-0" />
                    )}
                  </div>
                </div>
              );
            }}
          />
        ) : (
          <ScrollArea className="h-full">{stateContent()}</ScrollArea>
        )}
      </div>
      {children}
    </DockPanel>
  );
}
