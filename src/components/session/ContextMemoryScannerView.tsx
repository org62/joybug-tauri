import { useRef, useState } from 'react';
import { useSessionContext } from '@/contexts/SessionContext';
import { useMemoryScanner, FIRST_SCAN_COMPARE_TYPES, NEXT_SCAN_COMPARE_TYPES, needsValue, needsSecondValue, ScanValueType, ScanCompareType } from '@/hooks/useMemoryScanner';
import { usePinnedAddresses } from '@/hooks/usePinnedAddresses';
import { useContextMenu } from '@/hooks/useContextMenu';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ScanSearch, Loader2, AlertTriangle, ChevronLeft, ChevronRight, X, Pin } from 'lucide-react';

const VALUE_TYPES: ScanValueType[] = ['U8', 'U16', 'U32', 'U64', 'F32', 'F64'];

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
  const displayStatus = sessionData?.displayStatus;
  const isPaused = displayStatus === 'Paused';
  const sessionId = sessionData?.session?.id;
  const onNavigateToDisassembly = sessionData.onNavigateToDisassembly;
  const onNavigateToMemory = sessionData.onNavigateToMemory;

  const scanner = useMemoryScanner(sessionId, isPaused);
  const { pinnedAddresses, addPin, confirmPinRaw, removePin } = usePinnedAddresses(sessionId);
  const scrollParentRef = useRef<HTMLDivElement>(null);
  const { contextMenu, contextMenuRef, openContextMenu, closeContextMenu } = useContextMenu<{ address: string }>();

  // State for raw address confirmation dialog
  const [rawPinDialog, setRawPinDialog] = useState<{ address: string; valueType: string } | null>(null);

  const compareTypes = scanner.isFirstScan ? FIRST_SCAN_COMPARE_TYPES : NEXT_SCAN_COMPARE_TYPES;
  const showValue = needsValue(scanner.compareType);
  const showValue2 = needsSecondValue(scanner.compareType);

  const virtualizer = useVirtualizer({
    count: scanner.results.length,
    getScrollElement: () => scrollParentRef.current,
    estimateSize: () => 28,
    overscan: 20,
  });

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

  const handlePinAddress = async (address: string) => {
    const result = await addPin(address, scanner.valueType);
    if (!result.in_module) {
      setRawPinDialog({ address, valueType: scanner.valueType });
    }
    closeContextMenu();
  };

  const handleConfirmRawPin = async () => {
    if (rawPinDialog) {
      await confirmPinRaw(rawPinDialog.address, rawPinDialog.valueType);
      setRawPinDialog(null);
    }
  };

  const renderContent = () => {
    if (sessionData.session && !isPaused) {
      return (
        <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
          <div className="text-center">
            <ScanSearch className="h-12 w-12 mx-auto mb-4 opacity-50" />
            <p className="text-base font-medium">Memory scanner unavailable</p>
            <p className="text-sm mt-1">Session must be paused to scan memory</p>
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
      <ScrollArea className="h-full" viewportRef={scrollParentRef}>
        <div
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            width: '100%',
            position: 'relative',
          }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const entry = scanner.results[virtualRow.index];
            return (
              <div
                key={virtualRow.key}
                className="absolute w-full px-2 py-0.5 hover:bg-accent cursor-pointer font-mono text-sm flex"
                style={{
                  height: `${virtualRow.size}px`,
                  transform: `translateY(${virtualRow.start}px)`,
                }}
                onClick={() => onNavigateToMemory?.(entry.address)}
                onContextMenu={(e) => openContextMenu(e, { address: entry.address })}
              >
                <span className="w-[170px] shrink-0 text-muted-foreground">{entry.address}</span>
                <span className="flex-1 truncate">{entry.value.display}</span>
              </div>
            );
          })}
        </div>
      </ScrollArea>
    );
  };

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="p-2 border-b space-y-1">
        {/* Value type selector */}
        <div className="flex items-center gap-1 text-xs">
          {VALUE_TYPES.map((vt) => (
            <button
              key={vt}
              className={`px-1.5 py-0.5 rounded ${scanner.valueType === vt ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent'}`}
              onClick={() => scanner.setValueType(vt)}
              disabled={!scanner.isFirstScan}
            >
              {vt}
            </button>
          ))}
        </div>

        {/* Compare type + value inputs */}
        <div className="flex gap-1">
          <Select value={scanner.compareType} onValueChange={(v) => scanner.setCompareType(v as ScanCompareType)} disabled={!isPaused}>
            <SelectTrigger size="sm" className="flex-shrink-0">
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
              placeholder={showValue2 ? 'Min / Value' : 'Value (dec or 0x hex)'}
              value={scanner.value}
              onChange={(e) => scanner.setValue(e.target.value)}
              onKeyDown={handleKeyDown}
              className="flex-1"
              disabled={!isPaused}
            />
          )}
          {showValue2 && (
            <Input
              type="text"
              placeholder="Max / Amount"
              value={scanner.value2}
              onChange={(e) => scanner.setValue2(e.target.value)}
              onKeyDown={handleKeyDown}
              className="flex-1"
              disabled={!isPaused}
            />
          )}
        </div>

        {/* Action buttons */}
        <div className="flex gap-1 items-center">
          {scanner.isFirstScan ? (
            <Button
              size="sm"
              onClick={scanner.handleFirstScan}
              disabled={!isPaused || scanner.isScanning || (showValue && !scanner.value.trim())}
            >
              First Scan
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={scanner.handleNextScan}
              disabled={!isPaused || scanner.isScanning || (showValue && !scanner.value.trim())}
            >
              Next Scan
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={scanner.handleNewScan}
            disabled={scanner.isFirstScan && scanner.scanId === null}
          >
            New Scan
          </Button>

          <div className="flex items-center gap-1.5 ml-auto">
            <Switch checked={scanner.writableOnly} onCheckedChange={scanner.setWritableOnly} disabled={!scanner.isFirstScan} />
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
      </div>

      {/* Pinned Addresses */}
      {pinnedAddresses.length > 0 && (
        <div className="border-b">
          <div className="px-2 py-1 text-xs text-muted-foreground flex items-center gap-1">
            <Pin className="h-3 w-3" />
            Pinned Addresses
          </div>
          {pinnedAddresses.map((pin, i) => (
            <div
              key={`${pin.address_hex}-${i}`}
              className={`flex items-center gap-2 px-2 py-0.5 text-sm hover:bg-accent ${!pin.is_resolved ? 'opacity-50' : ''}`}
            >
              <span
                className="font-mono text-xs cursor-pointer hover:underline shrink-0"
                onClick={() => pin.is_resolved && onNavigateToMemory?.(pin.address_hex)}
              >
                {pin.address_hex}
              </span>
              <span className="text-xs text-muted-foreground shrink-0">
                {pin.module_name ?? 'raw'}
              </span>
              <span className="text-xs text-muted-foreground shrink-0">{pin.value_type}</span>
              {pin.label && <span className="text-xs truncate">{pin.label}</span>}
              {!pin.is_resolved && <span className="text-xs text-muted-foreground">(unresolved)</span>}
              <button
                className="ml-auto p-0.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground shrink-0"
                onClick={() => removePin(pin.address_hex, pin.module_name)}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Results */}
      <div className="flex-1 min-h-0">
        {renderContent()}
      </div>

      {/* Pagination */}
      {scanner.totalPages > 1 && (
        <div className="p-1 border-t flex items-center justify-between text-xs text-muted-foreground">
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2"
            disabled={scanner.currentPage === 0}
            onClick={() => scanner.loadPage(scanner.currentPage - 1)}
          >
            <ChevronLeft className="h-3 w-3" />
          </Button>
          <span>
            Page {scanner.currentPage + 1} of {scanner.totalPages} ({scanner.totalCount.toLocaleString()} total)
          </span>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2"
            disabled={scanner.currentPage >= scanner.totalPages - 1}
            onClick={() => scanner.loadPage(scanner.currentPage + 1)}
          >
            <ChevronRight className="h-3 w-3" />
          </Button>
        </div>
      )}

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
              onClick={() => { onNavigateToDisassembly(contextMenu.data.address); closeContextMenu(); }}
            >
              Go to Disassembly
            </button>
          )}
          {onNavigateToMemory && (
            <button
              className="w-full px-3 py-1.5 text-sm text-left hover:bg-accent hover:text-accent-foreground"
              onClick={() => { onNavigateToMemory(contextMenu.data.address); closeContextMenu(); }}
            >
              Go to Memory View
            </button>
          )}
          <button
            className="w-full px-3 py-1.5 text-sm text-left hover:bg-accent hover:text-accent-foreground"
            onClick={() => handlePinAddress(contextMenu.data.address)}
          >
            Pin Address
          </button>
        </div>
      )}

      {/* Raw Address Confirmation Dialog */}
      <Dialog open={rawPinDialog !== null} onOpenChange={(open) => { if (!open) setRawPinDialog(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Pin Non-Module Address</DialogTitle>
            <DialogDescription>
              The address <span className="font-mono">{rawPinDialog?.address}</span> is not within any loaded module.
              It will be saved as a raw address and won't survive ASLR across restarts.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRawPinDialog(null)}>Cancel</Button>
            <Button onClick={handleConfirmRawPin}>Pin Anyway</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
