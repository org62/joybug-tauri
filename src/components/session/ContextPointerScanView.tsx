import { useEffect } from 'react';
import { useSessionContext } from '@/contexts/SessionContext';
import { usePointerScan, PointerPathEntry } from '@/hooks/usePointerScan';
import { useContextMenu } from '@/hooks/useContextMenu';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { VirtualizedList } from '@/components/ui/virtualized-list';
import { ScrollArea } from '@/components/ui/scroll-area';
import { DockPanel, PanelFooter } from '@/components/ui/panel';
import { ContextMenu, ContextMenuItem } from '@/components/ui/context-menu';
import { TruncatedSymbol } from '@/components/ui/truncated-symbol';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
  DropdownMenuCheckboxItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { Crosshair, Loader2, AlertTriangle, ChevronLeft, ChevronRight, ChevronDown } from 'lucide-react';

function formatPath(p: PointerPathEntry): string {
  let s = p.base_symbol ?? `${p.module_base}+${p.base_offset}`;
  for (const off of p.offsets) s += ` → +${off}`;
  return s;
}

// Basename of a module path (e.g. "C:\\Windows\\System32\\ntdll.dll" -> "ntdll.dll").
function moduleBasename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

// Centered icon + title + subtitle, shared by every non-results state.
function EmptyState({ icon, title, subtitle, danger }: {
  icon: React.ReactNode; title: string; subtitle: string; danger?: boolean;
}) {
  return (
    <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
      <div className="text-center">
        {icon}
        <p className="text-base font-medium">{title}</p>
        <p className={`text-sm mt-1${danger ? ' text-destructive' : ''}`}>{subtitle}</p>
      </div>
    </div>
  );
}

export const ContextPointerScanView = () => {
  const sessionData = useSessionContext();
  const canUse = sessionData.canUseMemoryOps;
  const sessionId = sessionData?.session?.id;
  const onNavigateToMemory = sessionData.onNavigateToMemory;
  const { addBookmark } = sessionData.bookmarkState;
  const modules = sessionData?.modules ?? [];
  const loadModules = sessionData?.loadModules;

  const scan = usePointerScan(sessionId, canUse);
  const { contextMenu, openContextMenu, closeContextMenu } = useContextMenu<{ entry: PointerPathEntry }>();

  const handleAddBookmark = (p: PointerPathEntry) => {
    // Static base = module base + base offset; the chain offsets follow it.
    const baseAddr = '0x' + (parseInt(p.module_base, 16) + parseInt(p.base_offset, 16)).toString(16);
    addBookmark({
      kind: 'pointer',
      address: baseAddr,
      valueType: 'U32',
      pointerOffsets: p.offsets,
      baseSymbol: p.base_symbol ?? undefined,
    });
  };

  // Load the module list so the user can pick which modules to root paths in.
  useEffect(() => {
    if (sessionId && canUse) loadModules?.();
  }, [sessionId, canUse, loadModules]);

  const selected = new Set(scan.selectedModuleBases);
  const toggleModule = (base: string) => {
    scan.setSelectedModuleBases((prev) =>
      prev.includes(base) ? prev.filter((b) => b !== base) : [...prev, base]
    );
  };
  const moduleLabel = selected.size === 0
    ? 'Modules: All'
    : `Modules: ${selected.size} selected`;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      scan.handleScan();
    }
  };

  const crosshairIcon = <Crosshair className="h-12 w-12 mx-auto mb-4 opacity-50" />;

  const renderContent = () => {
    if (sessionData.session && !canUse) {
      return <EmptyState icon={crosshairIcon} title="Pointer scan unavailable"
        subtitle="Open or run a process to scan for pointers" />;
    }

    if (scan.isScanning) {
      return (
        <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
          <Loader2 className="h-8 w-8 mx-auto mb-4 animate-spin" />
          <p className="text-sm">Scanning for pointer paths...</p>
        </div>
      );
    }

    if (scan.error) {
      return <EmptyState
        icon={<AlertTriangle className="h-12 w-12 mx-auto mb-4 opacity-50 text-destructive" />}
        title="Pointer scan failed" subtitle={scan.error} danger />;
    }

    if (scan.resultsPath === null) {
      return <EmptyState icon={crosshairIcon} title="Pointer scanner"
        subtitle="Enter a target address and click Scan to find static pointer paths" />;
    }

    if (scan.results.length === 0) {
      return scan.offsetFilter.trim()
        ? <EmptyState icon={crosshairIcon} title="No paths match the filter"
            subtitle="No pointer path contains all of those offsets" />
        : <EmptyState icon={crosshairIcon} title="No pointer paths found"
            subtitle="Try a larger max offset or depth" />;
    }

    return (
      <VirtualizedList
        items={scan.results}
        rowHeight={28}
        className="h-full"
        renderItem={(p) => (
          <div
            className="w-full h-full px-2 py-0.5 hover:bg-accent cursor-pointer font-mono text-xs flex items-center gap-2"
            onClick={() => onNavigateToMemory?.(p.resolved)}
            onContextMenu={(e) => openContextMenu(e, { entry: p })}
          >
            <TruncatedSymbol text={formatPath(p)} className="flex-1" />
            <span className="shrink-0 text-muted-foreground">⇒ {p.resolved}</span>
          </div>
        )}
      />
    );
  };

  return (
    <DockPanel>
      {/* Toolbar (fixed; only the results below scroll) */}
      <div className="p-2 border-b space-y-1 shrink-0">
        <div className="flex gap-1">
          <Input
            type="text"
            placeholder="Target address (0x...)"
            value={scan.targetAddress}
            onChange={(e) => scan.setTargetAddress(e.target.value)}
            onKeyDown={handleKeyDown}
            className="flex-1 font-mono"
            disabled={!canUse}
          />
        </div>
        <div className="flex gap-1 items-center">
          <div className="flex items-center gap-1">
            <span className="text-xs text-muted-foreground">Max offset</span>
            <Input
              type="text"
              value={scan.maxOffset}
              onChange={(e) => scan.setMaxOffset(e.target.value)}
              onKeyDown={handleKeyDown}
              className="w-24 font-mono"
              disabled={!canUse}
            />
          </div>
          <div className="flex items-center gap-1">
            <span className="text-xs text-muted-foreground">Max depth</span>
            <Input
              type="text"
              value={scan.maxDepth}
              onChange={(e) => scan.setMaxDepth(e.target.value)}
              onKeyDown={handleKeyDown}
              className="w-14 font-mono"
              disabled={!canUse}
            />
          </div>
          {/* Base module selector */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline" className="ml-auto gap-1" disabled={!canUse}>
                {moduleLabel}
                <ChevronDown className="h-3 w-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="p-0">
              <DropdownMenuLabel className="flex items-center justify-between gap-4">
                <span>Base modules</span>
                {selected.size > 0 && (
                  <Button
                    variant="ghost"
                    size="xs"
                    className="text-muted-foreground"
                    onClick={() => scan.setSelectedModuleBases([])}
                  >
                    Clear
                  </Button>
                )}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              {modules.length === 0 ? (
                <DropdownMenuItem disabled>No modules loaded</DropdownMenuItem>
              ) : (
                <ScrollArea className="max-h-72">
                  {modules.map((m) => (
                    <DropdownMenuCheckboxItem
                      key={m.base_address}
                      checked={selected.has(m.base_address)}
                      onCheckedChange={() => toggleModule(m.base_address)}
                      onSelect={(e) => e.preventDefault()}
                      title={m.name}
                    >
                      <span className="font-mono text-xs">{moduleBasename(m.name)}</span>
                    </DropdownMenuCheckboxItem>
                  ))}
                </ScrollArea>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <div className="flex gap-1 items-center">
          <Button
            size="sm"
            onClick={scan.handleScan}
            disabled={!canUse || scan.isScanning || !scan.targetAddress.trim()}
          >
            Scan
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={scan.handleRescan}
            disabled={!canUse || scan.isScanning || scan.resultsPath === null || !scan.targetAddress.trim()}
            title="Keep only paths that still resolve to the target address above (narrow after the target moves or the game restarts)"
          >
            Rescan
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={scan.handleNewScan}
            disabled={scan.resultsPath === null}
          >
            New Scan
          </Button>
          <div className="flex items-center gap-1.5">
            <Switch checked={scan.writableOnly} onCheckedChange={scan.setWritableOnly} disabled={!canUse} />
            <span className="text-xs text-muted-foreground" title="Scan only writable regions (faster; may miss static roots in read-only data)">Writable only</span>
          </div>
          {scan.resultsPath !== null && (
            <div className="text-xs text-muted-foreground ml-auto">
              {scan.offsetFilter.trim()
                ? `${scan.totalCount.toLocaleString()} of ${scan.matchCount.toLocaleString()} match filter`
                : `${scan.matchCount.toLocaleString()} path${scan.matchCount !== 1 ? 's' : ''} found`}
              {!scan.offsetFilter.trim() && scan.scanTimeUs > 0 && ` (${(scan.scanTimeUs / 1000).toFixed(1)}ms)`}
            </div>
          )}
        </div>
        {scan.resultsPath !== null && (
          <div className="flex gap-1 items-center">
            <Input
              type="text"
              placeholder="Filter offsets (e.g. 0x88 0x10)"
              value={scan.offsetFilter}
              onChange={(e) => scan.setOffsetFilter(e.target.value)}
              inputSize="xs"
              className="flex-1 font-mono"
              title="Keep only paths whose chain offsets contain every value listed (order-independent)"
            />
            {scan.offsetFilter.trim() && (
              <>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={scan.handleApplyFilter}
                  disabled={!canUse || scan.isScanning || scan.totalCount === 0}
                  title="Discard all non-matching paths and keep only the filtered results as the new set"
                >
                  Keep {scan.totalCount.toLocaleString()} match{scan.totalCount !== 1 ? 'es' : ''}
                </Button>
                <Button size="xs" variant="ghost" onClick={() => scan.setOffsetFilter('')}>
                  Clear
                </Button>
              </>
            )}
          </div>
        )}
      </div>

      {/* Results */}
      <div className="flex-1 min-h-0">
        {renderContent()}
      </div>

      {/* Pagination (fixed footer) */}
      {scan.totalPages > 1 && (
        <PanelFooter className="justify-between text-xs text-muted-foreground">
          <Button
            size="icon-xs"
            variant="ghost"
            disabled={scan.currentPage === 0}
            onClick={() => scan.loadPage(scan.currentPage - 1)}
          >
            <ChevronLeft />
          </Button>
          <span>
            Page {scan.currentPage + 1} of {scan.totalPages} ({scan.totalCount.toLocaleString()} total)
          </span>
          <Button
            size="icon-xs"
            variant="ghost"
            disabled={scan.currentPage >= scan.totalPages - 1}
            onClick={() => scan.loadPage(scan.currentPage + 1)}
          >
            <ChevronRight />
          </Button>
        </PanelFooter>
      )}

      {/* Context Menu */}
      {contextMenu && (
        <ContextMenu x={contextMenu.x} y={contextMenu.y} onClose={closeContextMenu} className="min-w-[180px]">
          {onNavigateToMemory && (
            <ContextMenuItem onClick={() => onNavigateToMemory(contextMenu.data.entry.resolved)}>
              Go to Memory View
            </ContextMenuItem>
          )}
          <ContextMenuItem onClick={() => handleAddBookmark(contextMenu.data.entry)}>
            Add to Bookmarks (pointer)
          </ContextMenuItem>
        </ContextMenu>
      )}
    </DockPanel>
  );
};
