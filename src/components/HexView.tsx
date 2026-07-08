import { useState, useRef, useEffect, useCallback, useMemo, KeyboardEvent, MouseEvent } from "react";
import { VirtualizedList } from "./ui/virtualized-list";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { Binary, Save, X, ArrowRight, Copy, ClipboardPaste, ChevronLeft, ChevronRight, Crosshair, Bookmark } from "lucide-react";
import { useHexEditor } from "@/hooks/useHexEditor";
import { isProcessAvailable } from "@/lib/sessionHelpers";
import { useNavigationChannel } from "@/hooks/useNavigationChannel";
import { memoryNavigation } from "@/lib/navigationStore";
import {
  ViewMode,
  VIEW_MODE_CONFIGS,
  formatAddress,
  byteToAscii,
  BYTES_PER_ROW,
  RegisterContext,
  SymbolResolver,
  sanitizeAddressInput,
} from "@/lib/hexUtils";
import { PointerDereferenceDisplay } from "@/components/DereferenceDisplay";
import { DockPanel, PanelToolbar } from "@/components/ui/panel";
import { ContextMenu, ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { useContextMenu } from "@/hooks/useContextMenu";

interface HexViewProps {
  sessionId?: string;
  memoryViewId?: string;
  sessionStatus?: string;
  registers?: RegisterContext;
  resolveSymbol?: SymbolResolver;
  initialAddress?: bigint;
  initialViewMode?: ViewMode;
  onSetHardwareBreakpoint?: (address: string, hwType: string, hwSize: number) => void;
  onAddBookmark?: (address: string, valueType: string) => void;
}

const VIEWMODE_VALUE_TYPE: Record<ViewMode, string> = {
  byte: 'U8', word: 'U16', dword: 'U32', qword: 'U64', float: 'F32', pointer: 'U64',
};

export function HexView({ sessionId, memoryViewId, sessionStatus, registers = {}, resolveSymbol, initialAddress, initialViewMode, onSetHardwareBreakpoint, onAddBookmark }: HexViewProps) {
  const {
    baseAddress,
    memoryData,
    viewMode,
    isLoading,
    error,
    // Selection state
    selectionStart,
    selectionEnd,
    selectedOffsets,
    isDragging,
    // Editing state
    editingOffset,
    editingColumn,
    editBuffer,
    // Other
    pendingChanges,
    littleEndian,
    // Change detection
    changedOffsets,
    // Dereference data
    dereferenceData,
    // Actions
    goToAddress,
    setViewMode,
    // Pagination
    loadPreviousPage,
    loadNextPage,
    applyPendingChanges,
    discardPendingChanges,
    // Selection actions
    setSelection,
    clearSelection,
    extendSelection,
    setIsDragging,
    // Editing actions
    startHexEdit,
    startAsciiEdit,
    handleKeyInput,
    commitEdit,
    cancelEdit,
    // Clipboard actions
    copySelection,
    pasteBytes,
  } = useHexEditor({ sessionId, memoryViewId, sessionStatus, registers, resolveSymbol, initialAddress, initialViewMode });

  const [addressInput, setAddressInput] = useState("");
  const hexViewContainerRef = useRef<HTMLDivElement>(null);

  // External navigation (e.g., from symbol click or "Go to Memory")
  useNavigationChannel(memoryNavigation, goToAddress);

  // Context menu state
  const { contextMenu, openContextMenu, closeContextMenu } = useContextMenu();

  // Track mouse down offset for drag selection
  const [mouseDownOffset, setMouseDownOffset] = useState<number | null>(null);
  // Track if an actual drag occurred (mouse moved to different offset)
  const didDragRef = useRef(false);

  // Global mouse up listener for drag selection
  useEffect(() => {
    if (isDragging) {
      const handleMouseUp = () => {
        setIsDragging(false);
        setMouseDownOffset(null);
      };
      document.addEventListener('mouseup', handleMouseUp);
      return () => document.removeEventListener('mouseup', handleMouseUp);
    }
  }, [isDragging, setIsDragging]);

  // ============================================================================
  // Mouse event handlers for selection
  // ============================================================================

  const handleByteMouseDown = useCallback((offset: number, e: MouseEvent) => {
    // Only handle left-click (button 0) for selection
    // Right-click (button 2) should not affect selection - it opens context menu
    if (e.button !== 0) return;

    e.preventDefault();

    if (e.shiftKey && selectionStart !== null) {
      // Shift-click: extend selection
      extendSelection(offset);
    } else {
      // Normal click: start new selection
      cancelEdit(); // Clear any existing edit state
      setSelection(offset, offset);
      setMouseDownOffset(offset);
      setIsDragging(true);
      didDragRef.current = false; // Reset drag tracking
    }
  }, [selectionStart, extendSelection, setSelection, setIsDragging, cancelEdit]);

  const handleByteMouseMove = useCallback((offset: number) => {
    if (isDragging && mouseDownOffset !== null) {
      if (offset !== mouseDownOffset) {
        didDragRef.current = true; // User actually dragged to a different offset
      }
      extendSelection(offset);
    }
  }, [isDragging, mouseDownOffset, extendSelection]);

  const handleByteClick = useCallback((offset: number, e: MouseEvent) => {
    // If user actually dragged (moved to different offset), don't start edit
    if (didDragRef.current) return;

    // Focus the hex view container to capture keyboard events
    hexViewContainerRef.current?.focus();

    // Only start hex edit on single click (not shift-click)
    if (!e.shiftKey) {
      startHexEdit(offset);
    }
  }, [startHexEdit]);

  const handleAsciiClick = useCallback((offset: number, e: MouseEvent) => {
    if (didDragRef.current) return;

    // Focus the hex view container to capture keyboard events
    hexViewContainerRef.current?.focus();

    if (e.shiftKey && selectionStart !== null) {
      extendSelection(offset);
    } else {
      // Start editing this byte in ASCII mode
      startAsciiEdit(offset);
    }
  }, [selectionStart, extendSelection, startAsciiEdit]);

  // ============================================================================
  // Context menu handlers
  // ============================================================================

  // ============================================================================
  // Keyboard event handlers
  // ============================================================================

  const handleContainerKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
    // Skip handling if focus is on an input element (let it handle events normally)
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
      return;
    }

    // Escape: cancel edit or clear selection
    if (e.key === 'Escape') {
      e.preventDefault();
      if (editingOffset !== null) {
        cancelEdit();
      } else {
        clearSelection();
      }
      return;
    }

    // Ctrl+C: Copy
    if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
      e.preventDefault();
      copySelection('hex');
      return;
    }

    // Ctrl+V: Paste (default to hex mode for keyboard shortcut)
    if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
      e.preventDefault();
      pasteBytes('hex');
      return;
    }

    // Navigation keys
    const currentOffset = selectionStart ?? 0;
    const config = VIEW_MODE_CONFIGS[viewMode];
    let newOffset = currentOffset;
    let isNavigation = true;

    switch (e.key) {
      case 'ArrowLeft':
        commitEdit(); // Commit any partial edit
        newOffset = Math.max(0, currentOffset - config.bytesPerUnit);
        break;
      case 'ArrowRight':
        commitEdit();
        newOffset = Math.min(memoryData.length - 1, currentOffset + config.bytesPerUnit);
        break;
      case 'ArrowUp':
        commitEdit();
        newOffset = Math.max(0, currentOffset - BYTES_PER_ROW);
        break;
      case 'ArrowDown':
        commitEdit();
        newOffset = Math.min(memoryData.length - 1, currentOffset + BYTES_PER_ROW);
        break;
      case 'Home':
        commitEdit();
        newOffset = currentOffset - (currentOffset % BYTES_PER_ROW);
        break;
      case 'End':
        commitEdit();
        const rowStart = currentOffset - (currentOffset % BYTES_PER_ROW);
        newOffset = Math.min(memoryData.length - 1, rowStart + BYTES_PER_ROW - 1);
        break;
      case 'Tab':
        e.preventDefault();
        commitEdit();
        if (e.shiftKey) {
          newOffset = Math.max(0, currentOffset - 1);
        } else {
          newOffset = Math.min(memoryData.length - 1, currentOffset + 1);
        }
        break;
      case 'Enter':
        e.preventDefault();
        commitEdit();
        return;
      case 'Backspace':
        e.preventDefault();
        // Could implement backspace to clear last typed char, but for now just cancel
        cancelEdit();
        return;
      default:
        isNavigation = false;
    }

    if (isNavigation) {
      e.preventDefault();
      if (e.shiftKey && e.key !== 'Tab') {
        // Shift + arrow: extend selection
        extendSelection(newOffset);
      } else {
        // Normal navigation: move cursor
        setSelection(newOffset, newOffset);
        // Keep editing mode if we were editing
        if (editingOffset !== null) {
          if (editingColumn === 'ascii') {
            startAsciiEdit(newOffset);
          } else {
            startHexEdit(newOffset);
          }
        }
      }
      return;
    }

    // Try to handle as input character
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (handleKeyInput(e.key)) {
        e.preventDefault();
        e.stopPropagation(); // Prevent triggering other UI elements (like view mode dropdown)
      }
    }
  }, [
    editingOffset,
    editingColumn,
    cancelEdit,
    commitEdit,
    clearSelection,
    copySelection,
    pasteBytes,
    selectionStart,
    viewMode,
    memoryData.length,
    extendSelection,
    setSelection,
    startHexEdit,
    startAsciiEdit,
    handleKeyInput,
  ]);

  // Handle goto address
  const handleGoto = () => {
    if (addressInput.trim()) {
      goToAddress(addressInput.trim());
      setAddressInput("");
    }
  };

  // Handle enter key in address input
  const handleAddressKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      handleGoto();
    }
  };

  // Calculate rows
  const config = VIEW_MODE_CONFIGS[viewMode];
  // For pointer mode: 1 pointer per row (8 bytes), otherwise use standard 16 bytes per row
  const bytesPerRow = viewMode === 'pointer' ? config.bytesPerUnit : BYTES_PER_ROW;
  const unitsPerRow = viewMode === 'pointer' ? 1 : Math.floor(BYTES_PER_ROW / config.bytesPerUnit);
  const totalRows = Math.ceil(memoryData.length / bytesPerRow);
  const ROW_HEIGHT = 28;
  const rowIndices = useMemo(() => Array.from({ length: totalRows }, (_, i) => i), [totalRows]);

  // Can navigate to previous page if baseAddress > 0
  const canGoBack = baseAddress > 0n;

  // Empty state
  if (!sessionId) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
        <div className="text-center">
          <Binary className="h-12 w-12 mx-auto mb-4 opacity-50" />
          <p className="text-base font-medium">No session active</p>
          <p className="text-sm mt-1">Memory view will appear when debugging</p>
        </div>
      </div>
    );
  }

  // Check if session is active (can interact with memory). Includes the
  // non-invasive Open session, which reads memory over OOB without a debug loop.
  const isSessionActive = isProcessAvailable(sessionStatus);

  if (memoryData.length === 0 && !isLoading && !error) {
    // If session is active, show toolbar so user can enter address
    if (isSessionActive) {
      return (
        <DockPanel>
          <HexToolbar
            addressInput={addressInput}
            setAddressInput={setAddressInput}
            handleAddressKeyDown={handleAddressKeyDown}
            handleGoto={handleGoto}
            viewMode={viewMode}
            setViewMode={setViewMode}
            isLoading={isLoading}
            pendingChanges={pendingChanges}
            applyPendingChanges={applyPendingChanges}
            discardPendingChanges={discardPendingChanges}
            loadPreviousPage={loadPreviousPage}
            loadNextPage={loadNextPage}
            canGoBack={canGoBack}
          />
          <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground p-4">
            <div className="text-center">
              <Binary className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p className="text-base font-medium">No memory loaded</p>
              <p className="text-sm mt-1">Enter an address above to view memory</p>
            </div>
          </div>
        </DockPanel>
      );
    }

    // Session is stopped - show simple empty state
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
        <div className="text-center">
          <Binary className="h-12 w-12 mx-auto mb-4 opacity-50" />
          <p className="text-base font-medium">No memory loaded</p>
          <p className="text-sm mt-1">Start debugging to view memory</p>
        </div>
      </div>
    );
  }

  if (error) {
    // Show toolbar so user can try a different address
    return (
      <DockPanel>
        <HexToolbar
          addressInput={addressInput}
          setAddressInput={setAddressInput}
          handleAddressKeyDown={handleAddressKeyDown}
          handleGoto={handleGoto}
          viewMode={viewMode}
          setViewMode={setViewMode}
          isLoading={isLoading}
          pendingChanges={pendingChanges}
          applyPendingChanges={applyPendingChanges}
          discardPendingChanges={discardPendingChanges}
          loadPreviousPage={loadPreviousPage}
          loadNextPage={loadNextPage}
          canGoBack={canGoBack}
        />
        <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground p-4">
          <div className="text-center">
            <Binary className="h-12 w-12 mx-auto mb-4 opacity-50" />
            <p className="text-base font-medium">Could not load memory</p>
            <p className="text-sm mt-1">{error}</p>
            <p className="text-sm mt-2">Try a different address</p>
          </div>
        </div>
      </DockPanel>
    );
  }

  return (
    <DockPanel
      ref={hexViewContainerRef}
      className="outline-none"
      tabIndex={0}
      onKeyDown={handleContainerKeyDown}
    >
      {/* Toolbar - Fixed */}
      <HexToolbar
        addressInput={addressInput}
        setAddressInput={setAddressInput}
        handleAddressKeyDown={handleAddressKeyDown}
        handleGoto={handleGoto}
        viewMode={viewMode}
        setViewMode={setViewMode}
        isLoading={isLoading}
        pendingChanges={pendingChanges}
        applyPendingChanges={applyPendingChanges}
        discardPendingChanges={discardPendingChanges}
        loadPreviousPage={loadPreviousPage}
        loadNextPage={loadNextPage}
        canGoBack={canGoBack}
      />

      {/* Column Header - Fixed */}
      <div className="shrink-0 font-mono text-sm px-2 pt-2 pb-1 border-b border-border text-muted-foreground text-xs">
        <div className="flex items-center">
          <span className="w-36 shrink-0">Address</span>
          <span className="flex-1">{viewMode === 'pointer' ? 'Pointer' : 'Hex'}</span>
          {viewMode !== 'pointer' && (
            <span className="w-[136px] shrink-0 text-right pr-2">ASCII</span>
          )}
        </div>
      </div>

      {/* Hex Data - Scrollable + Virtualized */}
      <div className="flex-1 min-h-0" onContextMenu={(e) => openContextMenu(e, {})}>
        <VirtualizedList
          items={rowIndices}
          rowHeight={ROW_HEIGHT}
          className="h-full"
          renderItem={(rowIndex) => {
            const rowOffset = rowIndex * bytesPerRow;
            const rowAddress = baseAddress + BigInt(rowOffset);
            const rowBytes = memoryData.slice(rowOffset, rowOffset + bytesPerRow);

            return (
              <div className="flex items-center hover:bg-muted/30 h-full font-mono text-sm px-2 select-none">
                {/* Address column */}
                <span className="w-36 shrink-0 text-muted-foreground text-xs">
                  {formatAddress(rowAddress)}
                </span>

                {/* Hex values column */}
                <div className="flex-1 flex flex-wrap gap-x-1">
                  {Array.from({ length: unitsPerRow }).map((_, unitIndex) => {
                    const unitOffset = rowOffset + unitIndex * config.bytesPerUnit;
                    const unitBytes = memoryData.slice(
                      unitOffset,
                      unitOffset + config.bytesPerUnit
                    );

                    if (unitBytes.length < config.bytesPerUnit) {
                      return (
                        <span
                          key={unitIndex}
                          className="text-muted-foreground/30"
                          style={{ width: `${config.displayWidth}ch` }}
                        >
                          {"".padEnd(config.displayWidth, "-")}
                        </span>
                      );
                    }

                    // Check if any byte in this unit is selected
                    const isSelected = Array.from(
                      { length: config.bytesPerUnit },
                      (_, i) => selectedOffsets.has(unitOffset + i)
                    ).some(Boolean);
                    const isEditing = editingOffset === unitOffset && editingColumn === 'hex';
                    const hasPendingChange = Array.from(
                      { length: config.bytesPerUnit },
                      (_, i) => pendingChanges.has(unitOffset + i)
                    ).some(Boolean);
                    const hasChangedByte = Array.from(
                      { length: config.bytesPerUnit },
                      (_, i) => changedOffsets.has(unitOffset + i)
                    ).some(Boolean);

                    // Determine display value
                    let displayValue = config.formatValue(unitBytes, littleEndian);
                    if (isEditing && editBuffer.length > 0) {
                      if (viewMode === 'float') {
                        displayValue = editBuffer;
                      } else {
                        const remaining = config.displayWidth - editBuffer.length;
                        displayValue = editBuffer + '_'.repeat(remaining);
                      }
                    }

                    // Get dereference info for pointer mode
                    const unitAddress = baseAddress + BigInt(unitOffset);
                    const unitAddrStr = `0x${unitAddress.toString(16).padStart(16, '0').toUpperCase()}`;
                    const derefEntry = viewMode === 'pointer' ? dereferenceData.get(unitAddrStr) : undefined;

                    return (
                      <span
                        key={unitIndex}
                        className="inline-flex items-center gap-1"
                      >
                        <span
                          className={`cursor-pointer rounded px-0.5 inline-block text-center ${
                            isSelected
                              ? "bg-primary text-primary-foreground"
                              : hasPendingChange
                              ? "bg-yellow-200 dark:bg-yellow-800"
                              : hasChangedByte
                              ? "text-red-400 hover:bg-muted/50"
                              : "hover:bg-muted/50"
                          } ${isEditing ? "ring-1 ring-primary" : ""}`}
                          style={{ minWidth: `${config.displayWidth}ch` }}
                          onMouseDown={(e) => handleByteMouseDown(unitOffset, e)}
                          onMouseMove={() => handleByteMouseMove(unitOffset)}
                          onClick={(e) => handleByteClick(unitOffset, e)}
                        >
                          {displayValue}
                        </span>
                        <PointerDereferenceDisplay entry={derefEntry} />
                      </span>
                    );
                  })}
                </div>

                {/* ASCII column - hidden in pointer mode */}
                {viewMode !== 'pointer' && (
                  <span className="w-[136px] shrink-0 text-right pr-2 text-muted-foreground">
                    {Array.from(rowBytes).map((byte, i) => {
                      const offset = rowOffset + i;
                      const isSelected = selectedOffsets.has(offset);
                      const isAsciiEditing = editingOffset === offset && editingColumn === 'ascii';
                      const hasPending = pendingChanges.has(offset);
                      const hasChanged = changedOffsets.has(offset);
                      const char = byteToAscii(byte);

                      return (
                        <span
                          key={i}
                          className={`cursor-pointer ${
                            isSelected
                              ? "bg-primary text-primary-foreground"
                              : hasPending
                              ? "bg-yellow-200 dark:bg-yellow-800"
                              : hasChanged
                              ? "text-red-400"
                              : ""
                          } ${isAsciiEditing ? "ring-1 ring-primary" : ""}`}
                          onClick={(e) => handleAsciiClick(offset, e)}
                          onMouseDown={(e) => handleByteMouseDown(offset, e)}
                          onMouseMove={() => handleByteMouseMove(offset)}
                        >
                          {char}
                        </span>
                      );
                    })}
                  </span>
                )}
              </div>
            );
          }}
        />
      </div>

      {/* Status Bar - Fixed */}
      <div className="shrink-0">
        <HexStatusBar
          baseAddress={baseAddress}
          memoryData={memoryData}
          selectionStart={selectionStart}
          selectionEnd={selectionEnd}
          pendingChanges={pendingChanges}
          isLoading={isLoading}
        />
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={closeContextMenu}
          className="min-w-[160px]"
        >
          <ContextMenuItem
            icon={<Copy />}
            onClick={async () => {
              if (selectionStart !== null) {
                const address = baseAddress + BigInt(selectionStart);
                await navigator.clipboard.writeText(formatAddress(address));
              }
            }}
            disabled={selectionStart === null}
          >
            Copy Address
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            icon={<Copy />}
            onClick={() => copySelection('text')}
            disabled={selectionStart === null}
          >
            Copy Text
          </ContextMenuItem>
          <ContextMenuItem
            icon={<Copy />}
            onClick={() => copySelection('hex')}
            disabled={selectionStart === null}
          >
            Copy Hex
          </ContextMenuItem>
          <ContextMenuItem
            icon={<Copy />}
            onClick={() => copySelection('dump')}
            disabled={selectionStart === null}
          >
            Copy Dump
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            icon={<ClipboardPaste />}
            onClick={() => pasteBytes('hex')}
            disabled={selectionStart === null}
          >
            Paste Hex
          </ContextMenuItem>
          <ContextMenuItem
            icon={<ClipboardPaste />}
            onClick={() => pasteBytes('text')}
            disabled={selectionStart === null}
          >
            Paste Text
          </ContextMenuItem>
          {onAddBookmark && selectionStart !== null && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem
                icon={<Bookmark />}
                onClick={() => {
                  const address = baseAddress + BigInt(selectionStart);
                  onAddBookmark(`0x${address.toString(16)}`, VIEWMODE_VALUE_TYPE[viewMode]);
                }}
              >
                Add to Bookmarks
              </ContextMenuItem>
            </>
          )}
          {onSetHardwareBreakpoint && selectionStart !== null && (() => {
            const address = baseAddress + BigInt(selectionStart);
            const selSize = selectionEnd !== null ? Math.abs(selectionEnd - selectionStart) + 1 : 1;
            const hwSize = selSize >= 8 ? 8 : selSize >= 4 ? 4 : selSize >= 2 ? 2 : 1;
            const addrStr = `0x${address.toString(16)}`;
            return (
              <>
                <ContextMenuSeparator />
                <ContextMenuItem
                  icon={<Crosshair />}
                  onClick={() => onSetHardwareBreakpoint(addrStr, "Write", hwSize)}
                >
                  Break on Write ({hwSize}B)
                </ContextMenuItem>
                <ContextMenuItem
                  icon={<Crosshair />}
                  onClick={() => onSetHardwareBreakpoint(addrStr, "ReadWrite", hwSize)}
                >
                  Break on Read/Write ({hwSize}B)
                </ContextMenuItem>
              </>
            );
          })()}
        </ContextMenu>
      )}
    </DockPanel>
  );
}

// Toolbar component
interface HexToolbarProps {
  addressInput: string;
  setAddressInput: (value: string) => void;
  handleAddressKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void;
  handleGoto: () => void;
  viewMode: ViewMode;
  setViewMode: (mode: ViewMode) => void;
  isLoading: boolean;
  pendingChanges: Map<number, number>;
  applyPendingChanges: () => void;
  discardPendingChanges: () => void;
  loadPreviousPage: () => void;
  loadNextPage: () => void;
  canGoBack: boolean;
}

function HexToolbar({
  addressInput,
  setAddressInput,
  handleAddressKeyDown,
  handleGoto,
  viewMode,
  setViewMode,
  isLoading,
  pendingChanges,
  applyPendingChanges,
  discardPendingChanges,
  loadPreviousPage,
  loadNextPage,
  canGoBack,
}: HexToolbarProps) {
  return (
    <PanelToolbar className="gap-2">
      {/* Address input */}
      <div className="flex items-center gap-2">
        <Input
          placeholder="rsp, rax+0x10, symbol..."
          value={addressInput}
          onChange={(e) => setAddressInput(sanitizeAddressInput(e.target.value))}
          onKeyDown={handleAddressKeyDown}
        />
        <Button
          variant="outline"
          size="xs"
          onClick={handleGoto}
          title="Go to address"
        >
          <ArrowRight />
          <span>Go</span>
        </Button>
      </div>

      {/* Page navigation */}
      <div className="flex items-center gap-1">
        <Button
          variant="outline"
          size="icon-xs"
          onClick={loadPreviousPage}
          disabled={isLoading || !canGoBack}
          title="Previous page"
        >
          <ChevronLeft />
        </Button>
        <Button
          variant="outline"
          size="icon-xs"
          onClick={loadNextPage}
          disabled={isLoading}
          title="Next page"
        >
          <ChevronRight />
        </Button>
      </div>

      {/* View mode selector */}
      <Select value={viewMode} onValueChange={(v) => setViewMode(v as ViewMode)}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="byte">Byte</SelectItem>
          <SelectItem value="word">Word</SelectItem>
          <SelectItem value="dword">DWord</SelectItem>
          <SelectItem value="qword">QWord</SelectItem>
          <SelectItem value="float">Float</SelectItem>
          <SelectItem value="pointer">Pointer</SelectItem>
        </SelectContent>
      </Select>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Pending changes actions */}
      {pendingChanges.size > 0 && (
        <div className="flex items-center gap-1">
          <span className="text-xs text-yellow-600 dark:text-yellow-400">
            {pendingChanges.size} pending
          </span>
          <Button
            size="xs"
            variant="outline"
            onClick={applyPendingChanges}
            className="rounded-sm"
            title="Apply changes"
          >
            <Save />
          </Button>
          <Button
            size="xs"
            variant="outline"
            onClick={discardPendingChanges}
            className="rounded-sm"
            title="Discard changes"
          >
            <X />
          </Button>
        </div>
      )}
    </PanelToolbar>
  );
}

// Status bar component
interface HexStatusBarProps {
  baseAddress: bigint;
  memoryData: Uint8Array;
  selectionStart: number | null;
  selectionEnd: number | null;
  pendingChanges: Map<number, number>;
  isLoading: boolean;
}

function HexStatusBar({
  baseAddress,
  memoryData,
  selectionStart,
  selectionEnd,
  pendingChanges,
  isLoading,
}: HexStatusBarProps) {
  const endAddress = baseAddress + BigInt(memoryData.length);

  // Calculate selection info
  const hasSelection = selectionStart !== null && selectionEnd !== null;
  const selectionCount = hasSelection
    ? Math.abs(selectionEnd! - selectionStart!) + 1
    : 0;
  const normalizedStart = hasSelection
    ? Math.min(selectionStart!, selectionEnd!)
    : null;

  return (
    <div className="flex items-center gap-4 px-2 py-1 border-t border-border bg-muted/30 text-xs text-muted-foreground">
      {/* Address range */}
      <span>
        {formatAddress(baseAddress)} - {formatAddress(endAddress)}
      </span>

      {/* Size */}
      <span>{memoryData.length} bytes</span>

      {/* Selection info */}
      {hasSelection && (
        <span>
          {selectionCount === 1 ? (
            <>
              Cursor: {formatAddress(baseAddress + BigInt(normalizedStart!))} (offset +0x
              {normalizedStart!.toString(16).toUpperCase()})
            </>
          ) : (
            <>
              Selected: {selectionCount} bytes at{" "}
              {formatAddress(baseAddress + BigInt(normalizedStart!))}
            </>
          )}
        </span>
      )}

      {/* Loading indicator */}
      {isLoading && <span className="text-primary">Loading...</span>}

      {/* Pending changes count */}
      {pendingChanges.size > 0 && (
        <span className="text-yellow-600 dark:text-yellow-400">
          {pendingChanges.size} unsaved changes
        </span>
      )}
    </div>
  );
}
