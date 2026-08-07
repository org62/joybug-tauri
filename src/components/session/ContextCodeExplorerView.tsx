import { useEffect, useMemo, useRef, useState } from 'react';
import { useSessionContext, type Module } from '@/contexts/SessionContext';
import { useCodeExplorer, CoverageFn, TARGET_SOURCES, customEntryLines } from '@/hooks/useCodeExplorer';
import { useContextMenu } from '@/hooks/useContextMenu';
import { useColumnWidths } from '@/hooks/useColumnWidths';
import { usePanelFocus } from '@/hooks/usePanelFocus';
import { useHeaderScrollSync } from '@/hooks/useHeaderScrollSync';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { VirtualizedList } from '@/components/ui/virtualized-list';
import { DockPanel, PanelToolbar } from '@/components/ui/panel';
import { ContextMenu, ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu';
import { ResizableHeaderCell } from '@/components/ui/resizable-header-cell';
import { SortHeader } from '@/components/ui/sort-header';
import { EmptyState } from '@/components/ui/empty-state';
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { Radar, Search, AlertTriangle } from 'lucide-react';
import { moduleBasename, isTargetLive } from '@/lib/sessionHelpers';

interface CoverageRow extends CoverageFn {
  hitCount: number;
  seq: number | null; // 1-based first-execution order, null = not hit yet
  us: number | null; // µs from run start to first hit, null = not hit yet
  deltaUs: number | null; // µs since the previously executed function
  tids: number[];
}

const EMPTY_MODULES: Module[] = [];

/// Microseconds as milliseconds, at a fixed 3 decimals so the column reads as a
/// timeline: values line up digit-for-digit under `tabular-nums`.
const formatMs = (us: number) => (us / 1000).toFixed(3);

/// Tooltip note explaining a non-obvious target source (appended after the
/// symbol). `symbol`/`custom` need no note, so they're absent.
const SOURCE_NOTE: Partial<Record<CoverageFn['source'], string>> = {
  pdata: 'from the exception directory (.pdata)',
  validated: 'symbol not marked as a function; passed the code-sanity check',
};

/** Editor for the custom target list. Owns its own draft so keystrokes stay
 *  local — the parent (and its virtualized results table) never re-renders
 *  while typing, and Cancel discards without touching the hook. */
function CustomListDialog({ open, initial, moduleLabel, onClose, onSave }: {
  open: boolean;
  initial: string;
  moduleLabel: string;
  onClose: () => void;
  onSave: (text: string) => void;
}) {
  const [draft, setDraft] = useState(initial);
  // Re-seed from the saved list each time the dialog opens (it can change
  // between opens); mid-edit changes must not clobber what's being typed, so
  // `initial` is intentionally read only on the open transition.
  const initialRef = useRef(initial);
  initialRef.current = initial;
  useEffect(() => {
    if (open) setDraft(initialRef.current);
  }, [open]);
  const count = useMemo(() => customEntryLines(draft).length, [draft]);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Functions to explore</DialogTitle>
          <DialogDescription>
            One per line — a symbol name in {moduleLabel}, or a hex address like{' '}
            <span className="font-mono">0x140001000</span>. Only these are instrumented; the
            code-sanity filter is not applied. Blank lines and lines starting with{' '}
            <span className="font-mono">#</span> or <span className="font-mono">;</span> are
            ignored, and a <span className="font-mono">module!name</span> prefix is accepted.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="font-mono h-72 resize-none"
          spellCheck={false}
          placeholder={'main\n0x140001520\n# comments are ignored'}
        />
        <DialogFooter className="sm:justify-between">
          <span className="text-xs text-muted-foreground tabular-nums self-center">
            {count.toLocaleString()} entries
          </span>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button onClick={() => onSave(draft)}>Save</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export const ContextCodeExplorerView = () => {
  const sessionData = useSessionContext();
  // Only rendered once a scan has results; the hook no-ops until then.
  const focusRef = usePanelFocus<HTMLInputElement>('code_explorer');
  const canUse = sessionData.canUseMemoryOps;
  const sessionId = sessionData?.session?.id;
  const onNavigateToDisassembly = sessionData.onNavigateToDisassembly;
  const modules = sessionData?.modules ?? EMPTY_MODULES;
  const loadModules = sessionData?.loadModules;

  const ce = useCodeExplorer(
    sessionId,
    canUse,
    isTargetLive(sessionData.displayStatus),
    // Identifies the debuggee the coverage breakpoints were armed in; a restart
    // keeps the session but replaces this.
    sessionData.session?.current_event?.process_id,
  );
  // The list editor is a separate component owning its own draft (so typing in
  // it doesn't re-render this results table); this only tracks open/closed.
  const [listOpen, setListOpen] = useState(false);
  const { contextMenu, openContextMenu, closeContextMenu } = useContextMenu<{ row: CoverageRow }>();
  const { columnWidths, handleColumnResizeStart } = useColumnWidths('codeExplorerView', {
    address: 150, rva: 90, order: 60, time: 90, delta: 80, threads: 90, hits: 80,
  });

  // Below this width the results scroll horizontally instead of crushing the
  // columns: the seven fixed columns + px-2 padding + a floor for the symbol.
  const rowMinWidth = `${columnWidths.address + columnWidths.rva + columnWidths.order
    + columnWidths.time + columnWidths.delta + columnWidths.threads + columnWidths.hits + 16 + 160}px`;
  const { headerInnerRef, handleViewportScroll } = useHeaderScrollSync(rowMinWidth);

  // Load the module list so the user can pick which module to instrument.
  useEffect(() => {
    if (sessionId && canUse) loadModules?.();
  }, [sessionId, canUse, loadModules]);

  // Default the module selection to the main executable once modules are known.
  const setSelectedModule = ce.setSelectedModule;
  useEffect(() => {
    if (ce.selectedModule || modules.length === 0) return;
    const exe = modules.find((m) => m.name.toLowerCase().endsWith('.exe')) ?? modules[0];
    setSelectedModule(exe.name);
  }, [modules, ce.selectedModule, setSelectedModule]);

  // First-hit timestamp by execution order, so a row's delta is measured against
  // the function that actually ran before it — not against the row above it,
  // which the filter and the sort column both change.
  const usBySeq = useMemo(() => {
    const m = new Map<number, number>();
    for (const c of Object.values(ce.counts)) m.set(c.seq, c.us);
    return m;
  }, [ce.counts]);

  // Join the armed function table with live counts, then filter + sort
  // client-side. All rows come from one module, so RVA order == address order.
  const rows = useMemo<CoverageRow[]>(() => {
    const f = ce.filter.trim().toLowerCase();
    let r: CoverageRow[] = ce.functions.map((fn) => {
      const c = ce.counts[fn.address];
      const previous = c && c.seq > 1 ? usBySeq.get(c.seq - 1) : undefined;
      return {
        ...fn,
        hitCount: c?.count ?? 0,
        seq: c?.seq ?? null,
        us: c?.us ?? null,
        // seq 1 has no predecessor — its own timestamp is the elapsed time.
        deltaUs: c && previous !== undefined ? c.us - previous : null,
        tids: c?.tids ?? [],
      };
    });
    if (ce.hitOnly) r = r.filter((x) => x.hitCount > 0);
    if (f) r = r.filter((x) => x.symbol.toLowerCase().includes(f));
    const dir = ce.sortAsc ? 1 : -1;
    r.sort((a, b) => {
      // Unhit rows (no seq, only visible with "Hit only" off) always sink to
      // the end of an execution-order sort, whichever direction it runs in.
      if (ce.sortKey === 'order' && (a.seq === null || b.seq === null)) {
        if (a.seq === b.seq) return a.rva - b.rva;
        return a.seq === null ? 1 : -1;
      }
      let cmp = 0;
      if (ce.sortKey === 'address') cmp = a.rva - b.rva;
      else if (ce.sortKey === 'hits') cmp = a.hitCount - b.hitCount || a.rva - b.rva;
      else if (ce.sortKey === 'order') cmp = a.seq! - b.seq! || a.rva - b.rva;
      else cmp = a.symbol.localeCompare(b.symbol);
      return cmp * dir;
    });
    return r;
  }, [ce.functions, ce.counts, ce.filter, ce.sortKey, ce.sortAsc, ce.hitOnly, usBySeq]);

  const total = ce.functions.length;
  // The backend only reports addresses hit at least once, so the count map's
  // size is the number of hit functions.
  const hitTotal = Object.keys(ce.counts).length;
  const maxHits = useMemo(() => rows.reduce((m, r) => Math.max(m, r.hitCount), 0), [rows]);
  const pct = total > 0 ? Math.round((hitTotal / total) * 100) : 0;
  const armedShort = moduleBasename(ce.armedModule);

  const customCount = useMemo(() => customEntryLines(ce.customList).length, [ce.customList]);
  // `ce.hasTargets` owns "would this arm anything?" (see the hook).
  const startDisabled = !canUse || ce.isStarting || ce.active || !ce.selectedModule || !ce.hasTargets;

  const radarIcon = <Radar className="h-12 w-12 mx-auto mb-4 opacity-50" />;

  const renderContent = () => {
    if (sessionData.session && !canUse) {
      return <EmptyState icon={radarIcon} title="Code Explorer unavailable"
        subtitle="Pause or run a process to record code coverage" />;
    }
    if (ce.error) {
      return <EmptyState
        icon={<AlertTriangle className="h-12 w-12 mx-auto mb-4 opacity-50 text-destructive" />}
        title="Code coverage failed" subtitle={ce.error} danger />;
    }
    if (total === 0) {
      return <EmptyState icon={radarIcon} title="Code Explorer"
        subtitle="Pick a module and click Start to breakpoint every function, then run the target" />;
    }
    if (rows.length === 0) {
      if (ce.hitOnly && hitTotal === 0 && !ce.filter.trim()) {
        return <EmptyState icon={radarIcon} title="No functions hit yet"
          subtitle="Run the target to record coverage, or turn off 'Hit only' to see the armed set" />;
      }
      return <EmptyState icon={radarIcon} title="No functions match the filter"
        subtitle="No symbol contains that text" />;
    }

    return (
      <VirtualizedList
        items={rows}
        rowHeight={28}
        className="h-full"
        minContentWidth={rowMinWidth}
        onViewportScroll={handleViewportScroll}
        getItemKey={(r) => r.address}
        renderItem={(r) => {
          const intensity = maxHits > 0 ? r.hitCount / maxHits : 0;
          return (
            <div
              className="w-full h-full px-2 py-0.5 hover:bg-accent cursor-pointer font-mono text-xs flex items-center"
              onClick={() => onNavigateToDisassembly?.(r.address)}
              onContextMenu={(e) => openContextMenu(e, { row: r })}
            >
              <span
                className="flex-1 min-w-0 truncate pr-1"
                title={SOURCE_NOTE[r.source] ? `${r.symbol} — ${SOURCE_NOTE[r.source]}` : r.symbol}
              >
                {r.symbol}
              </span>
              <span className="shrink-0 truncate pr-1 text-muted-foreground" style={{ width: columnWidths.address }}>
                {r.address}
              </span>
              <span className="shrink-0 truncate pr-1 text-muted-foreground" style={{ width: columnWidths.rva }}>
                0x{r.rva.toString(16).toUpperCase()}
              </span>
              <span className="shrink-0 truncate pr-1 text-muted-foreground tabular-nums" style={{ width: columnWidths.order }}>
                {r.seq ?? '–'}
              </span>
              <span
                className="shrink-0 truncate pr-1 text-right text-muted-foreground tabular-nums"
                style={{ width: columnWidths.time }}
                title={r.us !== null ? `First hit ${r.us.toLocaleString()} µs into the run` : undefined}
              >
                {r.us !== null ? formatMs(r.us) : '–'}
              </span>
              <span
                className="shrink-0 truncate pr-1 text-right text-muted-foreground tabular-nums"
                style={{ width: columnWidths.delta }}
                title={r.deltaUs !== null ? `${r.deltaUs.toLocaleString()} µs after the previous function` : undefined}
              >
                {r.deltaUs !== null ? `+${formatMs(r.deltaUs)}` : '–'}
              </span>
              <span
                className="shrink-0 truncate pr-1 text-muted-foreground tabular-nums"
                style={{ width: columnWidths.threads }}
                title={r.tids.join(', ')}
              >
                {r.tids.join(', ')}
              </span>
              <span
                className="shrink-0 truncate text-right tabular-nums rounded px-1"
                style={{
                  width: columnWidths.hits,
                  background: r.hitCount > 0 ? `rgba(239, 68, 68, ${0.15 + 0.55 * intensity})` : undefined,
                }}
              >
                {r.hitCount}
              </span>
            </div>
          );
        }}
      />
    );
  };

  return (
    <DockPanel>
      <PanelToolbar stack>
        <div className="flex gap-1 items-center">
          <Select
            value={ce.selectedModule ?? ''}
            onValueChange={ce.setSelectedModule}
            disabled={!canUse || ce.active}
          >
            <SelectTrigger size="xs" className="flex-1 min-w-0">
              <SelectValue placeholder="Select a module..." />
            </SelectTrigger>
            <SelectContent>
              {modules.map((m) => (
                <SelectItem key={m.base_address} value={m.name} className="text-xs">
                  <span className="font-mono">{moduleBasename(m.name)}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex items-center gap-1 shrink-0">
            <span className="text-xs text-muted-foreground" title="Hits before the breakpoint is auto-removed (1 = coverage, higher = heat map, 0 = never)">
              Limit
            </span>
            <Input
              type="text"
              inputSize="xs"
              value={ce.hitLimit}
              onChange={(e) => ce.setHitLimit(e.target.value)}
              className="w-14 font-mono"
              disabled={!canUse || ce.active}
            />
          </div>
          {ce.active ? (
            <Button size="xs" variant="destructive" onClick={ce.stop}>Stop</Button>
          ) : (
            <Button size="xs" onClick={ce.start} disabled={startDisabled}>
              {ce.isStarting ? 'Arming…' : 'Start'}
            </Button>
          )}
        </div>
        {/* Independent switches, not exclusive modes: they combine, so the
            exception directory can be armed alongside a hand-written list while
            the heuristic symbol tier stays off. */}
        <div className="flex gap-3 items-center">
          <span className="text-xs text-muted-foreground shrink-0">Targets</span>
          {TARGET_SOURCES.map(({ key, label, hint }) => (
            <label
              key={key}
              className="flex items-center gap-1.5 shrink-0 cursor-pointer select-none"
              title={hint}
            >
              <Checkbox
                checked={ce.targetSources[key]}
                onCheckedChange={(checked) => {
                  const on = checked === true;
                  ce.setTargetSources({ ...ce.targetSources, [key]: on });
                  // Turning the list on with nothing in it: go straight to the
                  // editor rather than leaving a switch that does nothing.
                  if (key === 'list' && on && customCount === 0) setListOpen(true);
                }}
                disabled={!canUse || ce.active}
              />
              <span className="text-xs">{label}</span>
            </label>
          ))}
          {ce.targetSources.list && (
            <Button
              size="xs"
              variant="outline"
              className="shrink-0 ml-auto"
              onClick={() => setListOpen(true)}
              disabled={ce.active}
            >
              {customCount > 0 ? `${customCount.toLocaleString()} entries` : 'Add entries…'}
            </Button>
          )}
        </div>
        {total > 0 && (
          <div className="flex gap-1 items-center">
            <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <Input
              ref={focusRef}
              type="text"
              placeholder="Filter by symbol"
              value={ce.filter}
              onChange={(e) => ce.setFilter(e.target.value)}
              inputSize="xs"
              className="flex-1 font-mono"
            />
            {ce.filter.trim() && (
              <Button size="xs" variant="ghost" onClick={() => ce.setFilter('')}>Clear</Button>
            )}
            <div className="flex items-center gap-1 shrink-0" title="Show only functions that were executed at least once">
              <Switch size="xs" checked={ce.hitOnly} onCheckedChange={ce.setHitOnly} />
              <span className="text-xs text-muted-foreground">Hit only</span>
            </div>
            <div className="text-xs text-muted-foreground ml-auto shrink-0 tabular-nums">
              {armedShort} · {hitTotal.toLocaleString()}/{total.toLocaleString()} hit ({pct}%)
              {ce.active && ' · live'}
              {ce.unresolved.length > 0 && (
                <span
                  className="text-destructive ml-1"
                  title={`Not found in this module:\n${ce.unresolved.slice(0, 50).join('\n')}${ce.unresolved.length > 50 ? `\n…and ${ce.unresolved.length - 50} more` : ''}`}
                >
                  · {ce.unresolved.length.toLocaleString()} unresolved
                </span>
              )}
            </div>
          </div>
        )}
      </PanelToolbar>

      {/* Column header row (sortable Symbol / Address / Hits) — fixed
          vertically, follows the list's horizontal scroll */}
      {rows.length > 0 && (
        <div className="shrink-0 overflow-hidden border-b bg-muted/30">
          <div
            ref={headerInnerRef}
            style={{ minWidth: rowMinWidth }}
            className="flex items-center px-2 py-1 text-xs font-medium text-muted-foreground select-none"
          >
            <span className="flex-1 min-w-0 pr-1">
              <SortHeader label="Symbol" active={ce.sortKey === 'symbol'} asc={ce.sortAsc}
                onClick={() => ce.toggleSort('symbol')} />
            </span>
            <ResizableHeaderCell width={columnWidths.address} onResizeStart={(e) => handleColumnResizeStart('address', e)}>
              <SortHeader label="Address" active={ce.sortKey === 'address'} asc={ce.sortAsc}
                onClick={() => ce.toggleSort('address')} />
            </ResizableHeaderCell>
            <ResizableHeaderCell width={columnWidths.rva} onResizeStart={(e) => handleColumnResizeStart('rva', e)}>
              RVA
            </ResizableHeaderCell>
            <ResizableHeaderCell width={columnWidths.order} onResizeStart={(e) => handleColumnResizeStart('order', e)}>
              <SortHeader label="Order" active={ce.sortKey === 'order'} asc={ce.sortAsc}
                onClick={() => ce.toggleSort('order')} />
            </ResizableHeaderCell>
            <ResizableHeaderCell
              width={columnWidths.time}
              onResizeStart={(e) => handleColumnResizeStart('time', e)}
              className="text-right"
            >
              <span title="Milliseconds from the start of the run to this function's first hit. Only the first hit is timed, so on a heat map (limit ≠ 1) this still marks first execution, not the repeats.">
                Time
              </span>
            </ResizableHeaderCell>
            <ResizableHeaderCell
              width={columnWidths.delta}
              onResizeStart={(e) => handleColumnResizeStart('delta', e)}
              className="text-right"
            >
              <span title="Milliseconds between this function's first hit and that of the function executed immediately before it (by Order), regardless of the current filter or sort.">
                Δ
              </span>
            </ResizableHeaderCell>
            <ResizableHeaderCell width={columnWidths.threads} onResizeStart={(e) => handleColumnResizeStart('threads', e)}>
              Threads
            </ResizableHeaderCell>
            <ResizableHeaderCell width={columnWidths.hits} onResizeStart={(e) => handleColumnResizeStart('hits', e)} className="text-right">
              <SortHeader label="Hits" active={ce.sortKey === 'hits'} asc={ce.sortAsc}
                onClick={() => ce.toggleSort('hits')} />
            </ResizableHeaderCell>
          </div>
        </div>
      )}

      {/* Results */}
      <div className="flex-1 min-h-0">
        {renderContent()}
      </div>

      <CustomListDialog
        open={listOpen}
        initial={ce.customList}
        moduleLabel={moduleBasename(ce.selectedModule ?? '') || 'the module'}
        onClose={() => setListOpen(false)}
        onSave={(text) => { ce.setCustomList(text); setListOpen(false); }}
      />

      {/* Context Menu */}
      {contextMenu && (
        <ContextMenu x={contextMenu.x} y={contextMenu.y} onClose={closeContextMenu} className="min-w-[180px]">
          {onNavigateToDisassembly && (
            <ContextMenuItem onClick={() => onNavigateToDisassembly(contextMenu.data.row.address)}>
              Go to Disassembly
            </ContextMenuItem>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => navigator.clipboard?.writeText(contextMenu.data.row.symbol).catch(() => {})}>
            Copy Symbol
          </ContextMenuItem>
          <ContextMenuItem onClick={() => navigator.clipboard?.writeText(contextMenu.data.row.address).catch(() => {})}>
            Copy Address
          </ContextMenuItem>
        </ContextMenu>
      )}
    </DockPanel>
  );
};
