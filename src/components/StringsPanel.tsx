import { ReactNode } from 'react';
import {
  StringEntry, StringScanController, StringEncodingFilter, ENCODING_OPTIONS,
} from '@/hooks/useStringScan';
import { useContextMenu } from '@/hooks/useContextMenu';
import { useColumnWidths } from '@/hooks/useColumnWidths';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { VirtualizedList } from '@/components/ui/virtualized-list';
import { DockPanel, PanelToolbar } from '@/components/ui/panel';
import { ContextMenu, ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu';
import { ResizableHeaderCell } from '@/components/ui/resizable-header-cell';
import { SortHeader } from '@/components/ui/sort-header';
import { EmptyState } from '@/components/ui/empty-state';
import { PaginationFooter } from '@/components/ui/pagination-footer';
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from '@/components/ui/select';
import { Type, Loader2, AlertTriangle, Search } from 'lucide-react';

interface StringsPanelProps {
  scan: StringScanController;
  /** Scope-specific controls on the first toolbar row (module/range selects). */
  scopeControls: ReactNode;
  onScan: () => void;
  scanDisabled: boolean;
  /** Grays the shared inputs (e.g. no process to scan). */
  controlsDisabled?: boolean;
  /** When set, replaces the content area with this message (source unusable). */
  unavailable?: { title: string; subtitle: string } | null;
  /** localStorage key for the column widths (kept separate per host view). */
  columnWidthsKey: string;
  /** Address-column display text; defaults to the entry's raw address string. */
  formatAddress?: (address: string) => string;
  /** Row click / context-menu "go to" target (receives the raw address string). */
  onNavigateToMemory?: (address: string) => void;
  memoryNavLabel?: string;
  onNavigateToDisassembly?: (address: string) => void;
}

/**
 * The strings scanner panel shared by the session Strings tab and the PE
 * viewer: scan controls (encoding, min length, contains), post-scan filter,
 * sortable/resizable result columns, paging, and the row context menu. The
 * host supplies the scan controller and the scope controls.
 */
export const StringsPanel = ({
  scan, scopeControls, onScan, scanDisabled, controlsDisabled = false, unavailable,
  columnWidthsKey, formatAddress, onNavigateToMemory, memoryNavLabel = 'Go to Memory View',
  onNavigateToDisassembly,
}: StringsPanelProps) => {
  const { contextMenu, openContextMenu, closeContextMenu } = useContextMenu<{ entry: StringEntry }>();
  const { columnWidths, handleColumnResizeStart } = useColumnWidths(columnWidthsKey, {
    address: 150, encoding: 55, length: 55,
  });

  const displayAddress = (address: string) => formatAddress?.(address) ?? address;

  const copyText = (text: string) => {
    navigator.clipboard?.writeText(text).catch(() => {});
  };

  const typeIcon = <Type className="h-12 w-12 mx-auto mb-4 opacity-50" />;

  const renderContent = () => {
    if (unavailable) {
      return <EmptyState icon={typeIcon} title={unavailable.title} subtitle={unavailable.subtitle} />;
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

    if (!scan.hasScanned) {
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
              {displayAddress(s.address)}
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
          {scopeControls}
          {scan.hasScanned && (
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
            disabled={controlsDisabled}
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
              disabled={controlsDisabled}
            />
          </div>
          <Input
            type="text"
            inputSize="xs"
            placeholder="Contains (optional)"
            value={scan.contains}
            onChange={(e) => scan.setContains(e.target.value)}
            className="flex-1 min-w-0 font-mono"
            disabled={controlsDisabled}
          />
          <Button size="xs" onClick={onScan} disabled={scanDisabled}>
            Scan
          </Button>
        </div>
        {scan.hasScanned && (
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
      {scan.hasScanned && scan.results.length > 0 && (
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
              {memoryNavLabel}
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
          <ContextMenuItem onClick={() => copyText(displayAddress(contextMenu.data.entry.address))}>
            Copy Address
          </ContextMenuItem>
        </ContextMenu>
      )}
    </DockPanel>
  );
};
