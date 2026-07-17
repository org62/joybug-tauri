import { useEffect, useMemo } from 'react';
import { useSessionContext, type Module } from '@/contexts/SessionContext';
import { useCodeExplorer, CoverageFn } from '@/hooks/useCodeExplorer';
import { useContextMenu } from '@/hooks/useContextMenu';
import { useColumnWidths } from '@/hooks/useColumnWidths';
import { usePanelFocus } from '@/hooks/usePanelFocus';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
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
import { Radar, Search, AlertTriangle } from 'lucide-react';
import { moduleBasename, isTargetLive } from '@/lib/sessionHelpers';

interface CoverageRow extends CoverageFn {
  hitCount: number;
  seq: number | null; // 1-based first-execution order, null = not hit yet
  tids: number[];
}

const EMPTY_MODULES: Module[] = [];

export const ContextCodeExplorerView = () => {
  const sessionData = useSessionContext();
  // Only rendered once a scan has results; the hook no-ops until then.
  const focusRef = usePanelFocus<HTMLInputElement>('code_explorer');
  const canUse = sessionData.canUseMemoryOps;
  const sessionId = sessionData?.session?.id;
  const onNavigateToDisassembly = sessionData.onNavigateToDisassembly;
  const modules = sessionData?.modules ?? EMPTY_MODULES;
  const loadModules = sessionData?.loadModules;

  const ce = useCodeExplorer(sessionId, canUse, isTargetLive(sessionData.displayStatus));
  const { contextMenu, openContextMenu, closeContextMenu } = useContextMenu<{ row: CoverageRow }>();
  const { columnWidths, handleColumnResizeStart } = useColumnWidths('codeExplorerView', {
    address: 150, rva: 90, order: 60, threads: 90, hits: 80,
  });

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

  // Join the armed function table with live counts, then filter + sort
  // client-side. All rows come from one module, so RVA order == address order.
  const rows = useMemo<CoverageRow[]>(() => {
    const f = ce.filter.trim().toLowerCase();
    let r: CoverageRow[] = ce.functions.map((fn) => {
      const c = ce.counts[fn.address];
      return { ...fn, hitCount: c?.count ?? 0, seq: c?.seq ?? null, tids: c?.tids ?? [] };
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
  }, [ce.functions, ce.counts, ce.filter, ce.sortKey, ce.sortAsc, ce.hitOnly]);

  const total = ce.functions.length;
  // The backend only reports addresses hit at least once, so the count map's
  // size is the number of hit functions.
  const hitTotal = Object.keys(ce.counts).length;
  const maxHits = useMemo(() => rows.reduce((m, r) => Math.max(m, r.hitCount), 0), [rows]);
  const pct = total > 0 ? Math.round((hitTotal / total) * 100) : 0;
  const armedShort = moduleBasename(ce.armedModule);

  const startDisabled = !canUse || ce.isStarting || ce.active || !ce.selectedModule;

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
        getItemKey={(r) => r.address}
        renderItem={(r) => {
          const intensity = maxHits > 0 ? r.hitCount / maxHits : 0;
          return (
            <div
              className="w-full h-full px-2 py-0.5 hover:bg-accent cursor-pointer font-mono text-xs flex items-center"
              onClick={() => onNavigateToDisassembly?.(r.address)}
              onContextMenu={(e) => openContextMenu(e, { row: r })}
            >
              <span className="flex-1 min-w-0 truncate pr-1" title={r.symbol}>
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
            </div>
          </div>
        )}
      </PanelToolbar>

      {/* Column header row (sortable Symbol / Address / Hits) */}
      {rows.length > 0 && (
        <div className="flex items-center px-2 py-1 border-b bg-muted/30 text-xs font-medium text-muted-foreground select-none">
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
          <ResizableHeaderCell width={columnWidths.threads} onResizeStart={(e) => handleColumnResizeStart('threads', e)}>
            Threads
          </ResizableHeaderCell>
          <ResizableHeaderCell width={columnWidths.hits} onResizeStart={(e) => handleColumnResizeStart('hits', e)} className="text-right">
            <SortHeader label="Hits" active={ce.sortKey === 'hits'} asc={ce.sortAsc}
              onClick={() => ce.toggleSort('hits')} />
          </ResizableHeaderCell>
        </div>
      )}

      {/* Results */}
      <div className="flex-1 min-h-0">
        {renderContent()}
      </div>

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
