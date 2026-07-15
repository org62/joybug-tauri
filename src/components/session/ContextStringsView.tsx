import { useEffect } from 'react';
import { useSessionContext } from '@/contexts/SessionContext';
import {
  useStringScan, StringEntry, StringScanScope, StringEncodingFilter,
} from '@/hooks/useStringScan';
import { useContextMenu } from '@/hooks/useContextMenu';
import { useColumnWidths } from '@/hooks/useColumnWidths';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { VirtualizedList } from '@/components/ui/virtualized-list';
import { DockPanel, PanelToolbar } from '@/components/ui/panel';
import { ContextMenu, ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu';
import { ResizableHeaderCell } from '@/components/ui/resizable-header-cell';
import { EmptyState } from '@/components/ui/empty-state';
import { PaginationFooter } from '@/components/ui/pagination-footer';
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from '@/components/ui/select';
import {
  Type, Loader2, AlertTriangle, ChevronUp, ChevronDown, Search,
} from 'lucide-react';
import { moduleBasename } from '@/lib/sessionHelpers';
import { parseAddressToNumber } from '@/lib/hexUtils';

// Clickable, sortable column header label. Not a raw <button> (lint forbids those
// in views); a span with role/onClick carries the sort affordance + chevron.
function SortHeader({ label, active, asc, onClick }: {
  label: string; active: boolean; asc: boolean; onClick: () => void;
}) {
  return (
    <span
      role="button"
      tabIndex={0}
      className="inline-flex items-center gap-0.5 cursor-pointer select-none hover:text-foreground"
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}
    >
      {label}
      {active && (asc ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />)}
    </span>
  );
}

const SCOPE_OPTIONS: { value: StringScanScope; label: string }[] = [
  { value: 'module', label: 'Module' },
  { value: 'modules', label: 'All modules' },
  { value: 'readable', label: 'All readable memory' },
  { value: 'writable', label: 'Writable memory' },
  { value: 'executable', label: 'Executable memory' },
  { value: 'private', label: 'Private memory (heap/stack)' },
  { value: 'mapped', label: 'Mapped files' },
  { value: 'range', label: 'Custom range' },
];

/// Region filter each whole-address-space scope narrows to.
const SCOPE_REGION_FILTERS: Partial<Record<StringScanScope, string>> = {
  modules: 'image',
  readable: 'readable',
  writable: 'writable',
  executable: 'executable',
  private: 'private',
  mapped: 'mapped',
};

const ENCODING_OPTIONS: { value: StringEncodingFilter; label: string }[] = [
  { value: 'both', label: 'ASCII+UTF-16' },
  { value: 'ascii', label: 'ASCII' },
  { value: 'utf16', label: 'UTF-16' },
];

export const ContextStringsView = () => {
  const sessionData = useSessionContext();
  const canUse = sessionData.canUseMemoryOps;
  const sessionId = sessionData?.session?.id;
  const onNavigateToMemory = sessionData.onNavigateToMemory;
  const onNavigateToDisassembly = sessionData.onNavigateToDisassembly;
  const modules = sessionData?.modules ?? [];
  const loadModules = sessionData?.loadModules;

  const scan = useStringScan(sessionId, canUse);
  const { contextMenu, openContextMenu, closeContextMenu } = useContextMenu<{ entry: StringEntry }>();
  const { columnWidths, handleColumnResizeStart } = useColumnWidths('stringsView', {
    address: 150, encoding: 55, length: 55,
  });

  // Load the module list so the user can pick which module to scan.
  useEffect(() => {
    if (sessionId && canUse) loadModules?.();
  }, [sessionId, canUse, loadModules]);

  const rangeStart = parseAddressToNumber(scan.rangeStart);
  const rangeEnd = parseAddressToNumber(scan.rangeEnd);
  const rangeValid = rangeStart !== null && rangeEnd !== null && rangeEnd > rangeStart;

  const startScan = () => {
    if (scan.scope === 'module') {
      const mod = modules.find((m) => m.base_address === scan.selectedModuleBase);
      if (!mod) return;
      scan.handleScan({ startAddress: parseInt(mod.base_address, 16), size: mod.size, regionFilter: 'readable' });
    } else if (scan.scope === 'range') {
      if (!rangeValid) return;
      scan.handleScan({ startAddress: rangeStart, size: rangeEnd - rangeStart, regionFilter: 'readable' });
    } else {
      scan.handleScan({ startAddress: null, size: null, regionFilter: SCOPE_REGION_FILTERS[scan.scope] ?? 'readable' });
    }
  };

  const scanDisabled =
    !canUse || scan.isScanning ||
    (scan.scope === 'module' && !scan.selectedModuleBase) ||
    (scan.scope === 'range' && !rangeValid);

  const copyText = (text: string) => {
    navigator.clipboard?.writeText(text).catch(() => {});
  };

  const typeIcon = <Type className="h-12 w-12 mx-auto mb-4 opacity-50" />;

  const renderContent = () => {
    if (sessionData.session && !canUse) {
      return <EmptyState icon={typeIcon} title="Strings unavailable"
        subtitle="Open or run a process to scan for strings" />;
    }

    if (scan.isScanning) {
      return (
        <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
          <Loader2 className="h-8 w-8 mx-auto mb-4 animate-spin" />
          <p className="text-sm">Scanning for strings...</p>
        </div>
      );
    }

    if (scan.error) {
      return <EmptyState
        icon={<AlertTriangle className="h-12 w-12 mx-auto mb-4 opacity-50 text-destructive" />}
        title="String scan failed" subtitle={scan.error} danger />;
    }

    if (scan.resultsPath === null) {
      return <EmptyState icon={typeIcon} title="String scanner"
        subtitle="Choose where to search and click Scan to list strings" />;
    }

    if (scan.results.length === 0) {
      return scan.filter.trim()
        ? <EmptyState icon={typeIcon} title="No strings match the filter"
            subtitle="No string contains that text" />
        : <EmptyState icon={typeIcon} title="No strings found"
            subtitle="Try a smaller minimum length or a broader scope" />;
    }

    return (
      <VirtualizedList
        items={scan.results}
        rowHeight={28}
        className="h-full"
        getItemKey={(s, i) => `${s.address}:${i}`}
        renderItem={(s) => (
          <div
            className="w-full h-full px-2 py-0.5 hover:bg-accent cursor-pointer font-mono text-xs flex items-center"
            onClick={() => onNavigateToMemory?.(s.address)}
            onContextMenu={(e) => openContextMenu(e, { entry: s })}
          >
            <span className="shrink-0 truncate pr-1 text-muted-foreground" style={{ width: columnWidths.address }}>
              {s.address}
            </span>
            <span className="shrink-0 truncate pr-1" style={{ width: columnWidths.encoding }}>
              {s.encoding === 'utf16' ? 'U16' : 'ASC'}
            </span>
            <span className="shrink-0 truncate pr-1" style={{ width: columnWidths.length }}>
              {s.length}
            </span>
            <span className="flex-1 min-w-0 truncate" title={s.text}>
              {s.text}{s.truncated ? '…' : ''}
            </span>
          </div>
        )}
      />
    );
  };

  return (
    <DockPanel>
      {/* Toolbar (fixed; only the results below scroll) */}
      <PanelToolbar stack>
        <div className="flex gap-1 items-center">
          <Select
            value={scan.scope}
            onValueChange={(v) => scan.setScope(v as StringScanScope)}
            disabled={!canUse}
          >
            <SelectTrigger size="xs" className="w-44 shrink-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SCOPE_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value} className="text-xs">
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {scan.scope === 'module' && (
            <Select
              value={scan.selectedModuleBase ?? ''}
              onValueChange={scan.setSelectedModuleBase}
              disabled={!canUse}
            >
              <SelectTrigger size="xs" className="flex-1 min-w-0">
                <SelectValue placeholder="Select a module..." />
              </SelectTrigger>
              <SelectContent>
                {modules.map((m) => (
                  <SelectItem key={m.base_address} value={m.base_address} className="text-xs">
                    <span className="font-mono">{moduleBasename(m.name)}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {scan.scope === 'range' && (
            <>
              <Input
                type="text"
                inputSize="xs"
                placeholder="Start (hex)"
                value={scan.rangeStart}
                onChange={(e) => scan.setRangeStart(e.target.value)}
                className="flex-1 min-w-0 font-mono"
                disabled={!canUse}
              />
              <Input
                type="text"
                inputSize="xs"
                placeholder="End (hex)"
                value={scan.rangeEnd}
                onChange={(e) => scan.setRangeEnd(e.target.value)}
                className="flex-1 min-w-0 font-mono"
                disabled={!canUse}
              />
            </>
          )}
          {scan.resultsPath !== null && (
            <div className="text-xs text-muted-foreground ml-auto shrink-0">
              {scan.filter.trim()
                ? `${scan.totalCount.toLocaleString()} of ${scan.matchCount.toLocaleString()} match`
                : `${scan.matchCount.toLocaleString()} string${scan.matchCount !== 1 ? 's' : ''}`}
              {scan.capped && ' (capped)'}
              {!scan.filter.trim() && scan.scanTimeUs > 0 && ` (${(scan.scanTimeUs / 1000).toFixed(1)}ms)`}
            </div>
          )}
        </div>
        <div className="flex gap-1 items-center">
          <Select
            value={scan.encodings}
            onValueChange={(v) => scan.setEncodings(v as StringEncodingFilter)}
            disabled={!canUse}
          >
            <SelectTrigger size="xs" className="w-28 shrink-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ENCODING_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value} className="text-xs">
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex items-center gap-1 shrink-0">
            <span className="text-xs text-muted-foreground">Min len</span>
            <Input
              type="text"
              inputSize="xs"
              value={scan.minLength}
              onChange={(e) => scan.setMinLength(e.target.value)}
              className="w-14 font-mono"
              disabled={!canUse}
            />
          </div>
          <Input
            type="text"
            inputSize="xs"
            placeholder="Contains (optional)"
            value={scan.contains}
            onChange={(e) => scan.setContains(e.target.value)}
            className="flex-1 min-w-0 font-mono"
            disabled={!canUse}
          />
          <Button size="xs" onClick={startScan} disabled={scanDisabled}>
            Scan
          </Button>
        </div>
        {scan.resultsPath !== null && (
          <div className="flex gap-1 items-center">
            <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <Input
              type="text"
              placeholder="Filter strings"
              value={scan.filter}
              onChange={(e) => scan.setFilter(e.target.value)}
              inputSize="xs"
              className="flex-1 font-mono"
            />
            {scan.filter.trim() && (
              <Button size="xs" variant="ghost" onClick={() => scan.setFilter('')}>
                Clear
              </Button>
            )}
          </div>
        )}
      </PanelToolbar>

      {/* Column header row (sortable Address & String) */}
      {scan.resultsPath !== null && scan.results.length > 0 && (
        <div className="flex items-center px-2 py-1 border-b bg-muted/30 text-xs font-medium text-muted-foreground select-none">
          <ResizableHeaderCell width={columnWidths.address} onResizeStart={(e) => handleColumnResizeStart('address', e)}>
            <SortHeader label="Address" active={scan.sortKey === 'address'} asc={scan.sortAsc}
              onClick={() => scan.toggleSort('address')} />
          </ResizableHeaderCell>
          <ResizableHeaderCell width={columnWidths.encoding} onResizeStart={(e) => handleColumnResizeStart('encoding', e)}>
            Enc
          </ResizableHeaderCell>
          <ResizableHeaderCell width={columnWidths.length} onResizeStart={(e) => handleColumnResizeStart('length', e)}>
            <SortHeader label="Len" active={scan.sortKey === 'length'} asc={scan.sortAsc}
              onClick={() => scan.toggleSort('length')} />
          </ResizableHeaderCell>
          <span className="flex-1 min-w-0">
            <SortHeader label="String" active={scan.sortKey === 'value'} asc={scan.sortAsc}
              onClick={() => scan.toggleSort('value')} />
          </span>
        </div>
      )}

      {/* Results */}
      <div className="flex-1 min-h-0">
        {renderContent()}
      </div>

      {/* Pagination (fixed footer) */}
      <PaginationFooter currentPage={scan.currentPage} totalPages={scan.totalPages}
        totalCount={scan.totalCount} onPageChange={scan.loadPage} />

      {/* Context Menu */}
      {contextMenu && (
        <ContextMenu x={contextMenu.x} y={contextMenu.y} onClose={closeContextMenu} className="min-w-[180px]">
          {onNavigateToMemory && (
            <ContextMenuItem onClick={() => onNavigateToMemory(contextMenu.data.entry.address)}>
              Go to Memory View
            </ContextMenuItem>
          )}
          {onNavigateToDisassembly && (
            <ContextMenuItem onClick={() => onNavigateToDisassembly(contextMenu.data.entry.address)}>
              Go to Disassembly
            </ContextMenuItem>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => copyText(contextMenu.data.entry.text)}>
            Copy String
          </ContextMenuItem>
          <ContextMenuItem onClick={() => copyText(contextMenu.data.entry.address)}>
            Copy Address
          </ContextMenuItem>
        </ContextMenu>
      )}
    </DockPanel>
  );
};
