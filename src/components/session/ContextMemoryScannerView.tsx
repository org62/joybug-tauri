import { useSessionContext } from '@/contexts/SessionContext';
import { isTargetLive } from '@/lib/sessionHelpers';
import { cn, CHANGED_VALUE_CLASS } from '@/lib/utils';
import { useMemoryScanner, FIRST_SCAN_COMPARE_TYPES, NEXT_SCAN_COMPARE_TYPES, needsValue, needsSecondValue, ScanValueType, ScanCompareType } from '@/hooks/useMemoryScanner';
import { useContextMenu } from '@/hooks/useContextMenu';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { DockPanel, PanelToolbar, PanelFooter } from '@/components/ui/panel';
import { ContextMenu, ContextMenuItem } from '@/components/ui/context-menu';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { VirtualizedList } from '@/components/ui/virtualized-list';
import { ScanSearch, Loader2, AlertTriangle, ChevronLeft, ChevronRight } from 'lucide-react';

const VALUE_TYPES: ScanValueType[] = ['U8', 'U16', 'U32', 'U64', 'F32', 'F64'];

// Compare types whose float comparison uses the ± tolerance. For
// UnknownInitialValue it isn't used to match, but it is stored with the scan
// and inherited by later Changed/Unchanged/By next scans.
const TOLERANCE_COMPARE_TYPES: ScanCompareType[] = [
  'ExactValue', 'UnknownInitialValue', 'IncreasedValueBy', 'DecreasedValueBy', 'Changed', 'Unchanged',
];

const COMPARE_LABELS: Record<ScanCompareType, string> = {
  ExactValue: 'Exact Value',
  UnknownInitialValue: 'Unknown Initial Value',
  BiggerThan: 'Bigger Than',
  SmallerThan: 'Smaller Than',
  ValueBetween: 'Value Between',
  IncreasedValue: 'Increased',
  DecreasedValue: 'Decreased',
  IncreasedValueBy: 'Increased By',
  DecreasedValueBy: 'Decreased By',
  Changed: 'Changed',
  Unchanged: 'Unchanged',
};

export const ContextMemoryScannerView = () => {
  const sessionData = useSessionContext();
  const canUse = sessionData.canUseMemoryOps;
  // Live = the target keeps running (invasive Running or non-invasive Open), so
  // scan values must be polled; Paused is static and refreshes only after a step.
  const isLive = isTargetLive(sessionData.displayStatus);
  const sessionId = sessionData?.session?.id;
  const onNavigateToDisassembly = sessionData.onNavigateToDisassembly;
  const onNavigateToMemory = sessionData.onNavigateToMemory;
  const { addBookmark } = sessionData.bookmarkState;

  const scanner = useMemoryScanner(sessionId, canUse, isLive);
  const { contextMenu, openContextMenu, closeContextMenu } = useContextMenu<{ address: string }>();

  const compareTypes = scanner.isFirstScan ? FIRST_SCAN_COMPARE_TYPES : NEXT_SCAN_COMPARE_TYPES;
  const showValue = needsValue(scanner.compareType);
  const showValue2 = needsSecondValue(scanner.compareType);
  const isDeltaCompare = scanner.compareType === 'IncreasedValueBy' || scanner.compareType === 'DecreasedValueBy';
  const isFloatType = scanner.valueType === 'F32' || scanner.valueType === 'F64';
  const showTolerance = isFloatType && TOLERANCE_COMPARE_TYPES.includes(scanner.compareType);
  const tolerancePlaceholder = scanner.compareType === 'ExactValue'
    ? 'auto (from decimals typed)'
    : scanner.isFirstScan ? 'auto (1e-6)' : 'auto (inherited from first scan)';

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (scanner.isFirstScan) {
        scanner.handleFirstScan();
      } else {
        scanner.handleNextScan();
      }
    }
  };

  const handleAddBookmark = (address: string) => {
    addBookmark({ kind: 'value', address, valueType: scanner.valueType });
  };

  const renderContent = () => {
    if (sessionData.session && !canUse) {
      return (
        <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
          <div className="text-center">
            <ScanSearch className="h-12 w-12 mx-auto mb-4 opacity-50" />
            <p className="text-base font-medium">Memory scanner unavailable</p>
            <p className="text-sm mt-1">Open or run a process to scan memory</p>
          </div>
        </div>
      );
    }

    if (scanner.isScanning) {
      return (
        <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
          <Loader2 className="h-8 w-8 mx-auto mb-4 animate-spin" />
          <p className="text-sm">Scanning memory...</p>
        </div>
      );
    }

    if (scanner.error) {
      const isUnknownInitialValue = scanner.error.includes("unknown initial value scan");
      if (isUnknownInitialValue) {
        return (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
            <div className="text-center">
              <ScanSearch className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p className="text-base font-medium">Initial scan complete</p>
              <p className="text-sm mt-1">Run a next scan to narrow down results and see values</p>
            </div>
          </div>
        );
      }
      return (
        <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
          <div className="text-center">
            <AlertTriangle className="h-12 w-12 mx-auto mb-4 opacity-50 text-destructive" />
            <p className="text-base font-medium">Scan failed</p>
            <p className="text-sm mt-1 text-destructive">{scanner.error}</p>
          </div>
        </div>
      );
    }

    if (scanner.isFirstScan) {
      return (
        <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
          <div className="text-center">
            <ScanSearch className="h-12 w-12 mx-auto mb-4 opacity-50" />
            <p className="text-base font-medium">Iterative memory scanner</p>
            <p className="text-sm mt-1">Configure scan parameters and click First Scan</p>
          </div>
        </div>
      );
    }

    if (scanner.results.length === 0 && scanner.matchCount === 0) {
      return (
        <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
          <div className="text-center">
            <ScanSearch className="h-12 w-12 mx-auto mb-4 opacity-50" />
            <p className="text-base font-medium">No matches found</p>
            <p className="text-sm mt-1">Try different scan parameters or start a new scan</p>
          </div>
        </div>
      );
    }

    // Results list
    return (
      <VirtualizedList
        items={scanner.results}
        rowHeight={28}
        className="h-full"
        renderItem={(entry) => (
          <div
            className="w-full h-full px-2 py-0.5 hover:bg-accent cursor-pointer font-mono text-sm flex"
            onClick={() => onNavigateToMemory?.(entry.address)}
            onContextMenu={(e) => openContextMenu(e, { address: entry.address })}
          >
            <span className="w-[170px] shrink-0 text-muted-foreground">{entry.address}</span>
            <span
              data-changed={scanner.changedAddresses.has(entry.address) || undefined}
              className={cn("flex-1 truncate", scanner.changedAddresses.has(entry.address) && CHANGED_VALUE_CLASS)}
            >{entry.value.display}</span>
          </div>
        )}
      />
    );
  };

  return (
    <DockPanel>
      {/* Toolbar */}
      <PanelToolbar stack>
        {/* Value type selector */}
        <div className="flex items-center gap-1 text-xs">
          {VALUE_TYPES.map((vt) => (
            <Button
              key={vt}
              size="xs"
              variant={scanner.valueType === vt ? 'default' : 'ghost'}
              onClick={() => scanner.setValueType(vt)}
              disabled={!scanner.isFirstScan}
            >
              {vt}
            </Button>
          ))}
        </div>

        {/* Compare type + value inputs */}
        <div className="flex gap-1">
          <Select value={scanner.compareType} onValueChange={(v) => scanner.setCompareType(v as ScanCompareType)} disabled={!canUse}>
            <SelectTrigger size="xs" className="flex-shrink-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {compareTypes.map((ct) => (
                <SelectItem key={ct} value={ct}>{COMPARE_LABELS[ct]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {showValue && (
            <Input
              type="text"
              inputSize="xs"
              placeholder={showValue2 ? 'Min' : isDeltaCompare ? 'Amount' : 'Value (dec or 0x hex)'}
              value={scanner.value}
              onChange={(e) => scanner.setValue(e.target.value)}
              onKeyDown={handleKeyDown}
              className="flex-1"
              disabled={!canUse}
            />
          )}
          {showValue2 && (
            <Input
              type="text"
              inputSize="xs"
              placeholder="Max"
              value={scanner.value2}
              onChange={(e) => scanner.setValue2(e.target.value)}
              onKeyDown={handleKeyDown}
              className="flex-1"
              disabled={!canUse}
            />
          )}
        </div>

        {showTolerance && (
          <div className="flex items-center gap-1.5">
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="text-xs text-muted-foreground whitespace-nowrap cursor-help underline decoration-dotted underline-offset-2">± tolerance</span>
                </TooltipTrigger>
                <TooltipContent side="bottom" align="start" className="max-w-sm text-xs">
                  <p>How far off a value may be and still count as a match. A match is anything from (your number − tolerance) to (your number + tolerance).</p>
                  <p className="mt-1.5">Searching Exact Value <span className="font-mono">100</span>:</p>
                  <ul className="mt-0.5 ml-3 list-disc space-y-0.5">
                    <li>tolerance <span className="font-mono">1</span> → finds 99 to 101</li>
                    <li>tolerance <span className="font-mono">0.1</span> → finds 99.9 to 100.1</li>
                    <li>tolerance <span className="font-mono">0</span> → finds only exactly 100</li>
                  </ul>
                  <p className="mt-1.5">For Unchanged / Changed it is how much a value may drift and still count as "same". With tolerance <span className="font-mono">1</span>: 100 → 100.8 is Unchanged, 100 → 102 is Changed.</p>
                  <p className="mt-1.5">Blank = automatic. For Exact Value it matches whatever displays as your number: typing <span className="font-mono">100</span> finds 99.5 to 100.5, typing <span className="font-mono">100.0</span> finds 99.95 to 100.05. Next scans keep using the first scan's tolerance.</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <Input
              type="text"
              inputSize="xs"
              placeholder={tolerancePlaceholder}
              value={scanner.floatTolerance}
              onChange={(e) => scanner.setFloatTolerance(e.target.value)}
              onKeyDown={handleKeyDown}
              className="flex-1"
              disabled={!canUse}
            />
          </div>
        )}

        {/* Action buttons */}
        <div className="flex gap-1 items-center">
          {scanner.isFirstScan ? (
            <Button
              size="xs"
              onClick={scanner.handleFirstScan}
              disabled={!canUse || scanner.isScanning || (showValue && !scanner.value.trim())}
            >
              First Scan
            </Button>
          ) : (
            <Button
              size="xs"
              onClick={scanner.handleNextScan}
              disabled={!canUse || scanner.isScanning || (showValue && !scanner.value.trim())}
            >
              Next Scan
            </Button>
          )}
          <Button
            size="xs"
            variant="outline"
            onClick={scanner.handleNewScan}
            disabled={scanner.isFirstScan && scanner.scanId === null}
          >
            New Scan
          </Button>

          <div className="flex items-center gap-1.5 ml-auto">
            <Switch size="xs" checked={scanner.writableOnly} onCheckedChange={scanner.setWritableOnly} disabled={!scanner.isFirstScan} />
            <span className="text-xs text-muted-foreground">Writable</span>
          </div>
        </div>

        {/* Status */}
        {!scanner.isFirstScan && (
          <div className="text-xs text-muted-foreground">
            {scanner.matchCount.toLocaleString()} match{scanner.matchCount !== 1 ? 'es' : ''} found
            {scanner.scanTimeUs > 0 && ` (${(scanner.scanTimeUs / 1000).toFixed(1)}ms)`}
          </div>
        )}
      </PanelToolbar>

      {/* Results */}
      <div className="flex-1 min-h-0">
        {renderContent()}
      </div>

      {/* Pagination */}
      {scanner.totalPages > 1 && (
        <PanelFooter className="justify-between text-xs text-muted-foreground">
          <Button
            size="icon-xs"
            variant="ghost"
            disabled={scanner.currentPage === 0}
            onClick={() => scanner.loadPage(scanner.currentPage - 1)}
          >
            <ChevronLeft />
          </Button>
          <span>
            Page {scanner.currentPage + 1} of {scanner.totalPages} ({scanner.totalCount.toLocaleString()} total)
          </span>
          <Button
            size="icon-xs"
            variant="ghost"
            disabled={scanner.currentPage >= scanner.totalPages - 1}
            onClick={() => scanner.loadPage(scanner.currentPage + 1)}
          >
            <ChevronRight />
          </Button>
        </PanelFooter>
      )}

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
          <ContextMenuItem onClick={() => handleAddBookmark(contextMenu.data.address)}>
            Add to Bookmarks
          </ContextMenuItem>
        </ContextMenu>
      )}
    </DockPanel>
  );
};
