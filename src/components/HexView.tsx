import { useState, useRef, useEffect, useCallback, KeyboardEvent, MouseEvent } from "react";
import { ScrollArea } from "./ui/scroll-area";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { Binary, RefreshCw, Save, X, ArrowRight, Copy, ClipboardPaste } from "lucide-react";
import { useHexEditor } from "@/hooks/useHexEditor";
import {
  ViewMode,
  VIEW_MODE_CONFIGS,
  formatAddress,
  byteToAscii,
  BYTES_PER_ROW,
  RegisterContext,
  SymbolResolver,
} from "@/lib/hexUtils";

interface HexViewProps {
  sessionId?: string;
  memoryViewId?: string;
  sessionStatus?: string;
  registers?: RegisterContext;
  resolveSymbol?: SymbolResolver;
  initialAddress?: bigint;
}

export function HexView({ sessionId, memoryViewId = 'memory', sessionStatus, registers = {}, resolveSymbol, initialAddress }: HexViewProps) {
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
    // Actions
    goToAddress,
    refresh,
    setViewMode,
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
  } = useHexEditor({ sessionId, memoryViewId, sessionStatus, registers, resolveSymbol, initialAddress });

  const [addressInput, setAddressInput] = useState("");
  const hexViewContainerRef = useRef<HTMLDivElement>(null);

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  // Track mouse down offset for drag selection
  const [mouseDownOffset, setMouseDownOffset] = useState<number | null>(null);

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

  // Close context menu on click outside (left-click only, and only if outside menu)
  useEffect(() => {
    if (contextMenu) {
      const handleClick = (e: globalThis.MouseEvent) => {
        // Only close on left click outside the context menu
        if (e.button === 0) {
          // Check if click is inside the context menu
          if (contextMenuRef.current && contextMenuRef.current.contains(e.target as Node)) {
            return; // Don't close if clicking inside the menu
          }
          setContextMenu(null);
        }
      };
      document.addEventListener('mousedown', handleClick);
      return () => {
        document.removeEventListener('mousedown', handleClick);
      };
    }
  }, [contextMenu]);

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
      setSelection(offset, offset);
      setMouseDownOffset(offset);
      setIsDragging(true);
    }
  }, [selectionStart, extendSelection, setSelection, setIsDragging]);

  const handleByteMouseMove = useCallback((offset: number) => {
    if (isDragging && mouseDownOffset !== null) {
      extendSelection(offset);
    }
  }, [isDragging, mouseDownOffset, extendSelection]);

  const handleByteClick = useCallback((offset: number, e: MouseEvent) => {
    // If we were dragging, don't start edit
    if (isDragging) return;

    // Focus the hex view container to capture keyboard events
    hexViewContainerRef.current?.focus();

    // Only start hex edit on single click (not shift-click)
    if (!e.shiftKey) {
      startHexEdit(offset);
    }
  }, [isDragging, startHexEdit]);

  const handleAsciiClick = useCallback((offset: number, e: MouseEvent) => {
    if (isDragging) return;

    // Focus the hex view container to capture keyboard events
    hexViewContainerRef.current?.focus();

    if (e.shiftKey && selectionStart !== null) {
      extendSelection(offset);
    } else {
      // Start editing this byte in ASCII mode
      startAsciiEdit(offset);
    }
  }, [isDragging, selectionStart, extendSelection, startAsciiEdit]);

  // ============================================================================
  // Context menu handlers
  // ============================================================================

  const handleContextMenu = useCallback((e: MouseEvent) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY });
  }, []);

  // ============================================================================
  // Keyboard event handlers
  // ============================================================================

  const handleContainerKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
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

    // Ctrl+V: Paste
    if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
      e.preventDefault();
      pasteBytes();
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
  const unitsPerRow = Math.floor(BYTES_PER_ROW / config.bytesPerUnit);
  const totalRows = Math.ceil(memoryData.length / BYTES_PER_ROW);

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

  // Check if session is active (can interact with memory)
  const isSessionActive = sessionStatus === 'Running' || sessionStatus === 'Paused';

  if (memoryData.length === 0 && !isLoading && !error) {
    // If session is active, show toolbar so user can enter address
    if (isSessionActive) {
      return (
        <div className="absolute inset-0 flex flex-col overflow-hidden">
          <div className="shrink-0">
            <HexToolbar
              addressInput={addressInput}
              setAddressInput={setAddressInput}
              handleAddressKeyDown={handleAddressKeyDown}
              handleGoto={handleGoto}
              viewMode={viewMode}
              setViewMode={setViewMode}
              refresh={refresh}
              isLoading={isLoading}
              pendingChanges={pendingChanges}
              applyPendingChanges={applyPendingChanges}
              discardPendingChanges={discardPendingChanges}
            />
          </div>
          <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground p-4">
            <div className="text-center">
              <Binary className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p className="text-base font-medium">No memory loaded</p>
              <p className="text-sm mt-1">Enter an address above to view memory</p>
            </div>
          </div>
        </div>
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
      <div className="absolute inset-0 flex flex-col overflow-hidden">
        <div className="shrink-0">
          <HexToolbar
            addressInput={addressInput}
            setAddressInput={setAddressInput}
            handleAddressKeyDown={handleAddressKeyDown}
            handleGoto={handleGoto}
            viewMode={viewMode}
            setViewMode={setViewMode}
            refresh={refresh}
            isLoading={isLoading}
            pendingChanges={pendingChanges}
            applyPendingChanges={applyPendingChanges}
            discardPendingChanges={discardPendingChanges}
          />
        </div>
        <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground p-4">
          <div className="text-center">
            <Binary className="h-12 w-12 mx-auto mb-4 opacity-50" />
            <p className="text-base font-medium">Could not load memory</p>
            <p className="text-sm mt-1">{error}</p>
            <p className="text-sm mt-2">Try a different address</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={hexViewContainerRef}
      className="absolute inset-0 flex flex-col overflow-hidden outline-none"
      tabIndex={0}
      onKeyDown={handleContainerKeyDown}
    >
      {/* Toolbar - Fixed */}
      <div className="shrink-0">
        <HexToolbar
          addressInput={addressInput}
          setAddressInput={setAddressInput}
          handleAddressKeyDown={handleAddressKeyDown}
          handleGoto={handleGoto}
          viewMode={viewMode}
          setViewMode={setViewMode}
          refresh={refresh}
          isLoading={isLoading}
          pendingChanges={pendingChanges}
          applyPendingChanges={applyPendingChanges}
          discardPendingChanges={discardPendingChanges}
        />
      </div>

      {/* Column Header - Fixed */}
      <div className="shrink-0 font-mono text-sm px-2 pt-2 pb-1 border-b border-border text-muted-foreground text-xs">
        <div className="flex items-center">
          <span className="w-36 shrink-0">Address</span>
          <span className="flex-1">Hex</span>
          <span className="w-[136px] shrink-0 text-right pr-2">ASCII</span>
        </div>
      </div>

      {/* Hex Data - Scrollable */}
      <ScrollArea className="flex-1 min-h-0">
        <div
          className="font-mono text-sm p-2 pt-1 hex-grid-area select-none"
          onContextMenu={handleContextMenu}
        >
          {/* Rows */}
          {Array.from({ length: totalRows }).map((_, rowIndex) => {
            const rowOffset = rowIndex * BYTES_PER_ROW;
            const rowAddress = baseAddress + BigInt(rowOffset);
            const rowBytes = memoryData.slice(rowOffset, rowOffset + BYTES_PER_ROW);

            return (
              <div
                key={rowIndex}
                className="flex items-center hover:bg-muted/30 py-0.5"
              >
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

                    // Determine display value
                    let displayValue = config.formatValue(unitBytes, littleEndian);
                    if (isEditing && viewMode === 'byte' && editBuffer.length > 0) {
                      // Show editBuffer padded with underscore for missing char
                      displayValue = editBuffer.length === 1
                        ? editBuffer + '_'
                        : editBuffer;
                    }

                    return (
                      <span
                        key={unitIndex}
                        className={`cursor-pointer rounded px-0.5 ${
                          isSelected
                            ? "bg-primary text-primary-foreground"
                            : hasPendingChange
                            ? "bg-yellow-200 dark:bg-yellow-800"
                            : "hover:bg-muted/50"
                        } ${isEditing ? "ring-1 ring-primary" : ""}`}
                        style={{ width: `${config.displayWidth}ch` }}
                        onMouseDown={(e) => handleByteMouseDown(unitOffset, e)}
                        onMouseMove={() => handleByteMouseMove(unitOffset)}
                        onClick={(e) => handleByteClick(unitOffset, e)}
                      >
                        {displayValue}
                      </span>
                    );
                  })}
                </div>

                {/* ASCII column */}
                <span className="w-[136px] shrink-0 text-right pr-2 text-muted-foreground">
                  {Array.from(rowBytes).map((byte, i) => {
                    const offset = rowOffset + i;
                    const isSelected = selectedOffsets.has(offset);
                    const isAsciiEditing = editingOffset === offset && editingColumn === 'ascii';
                    const hasPending = pendingChanges.has(offset);
                    const char = byteToAscii(byte);

                    return (
                      <span
                        key={i}
                        className={`cursor-pointer ${
                          isSelected
                            ? "bg-primary text-primary-foreground"
                            : hasPending
                            ? "bg-yellow-200 dark:bg-yellow-800"
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
              </div>
            );
          })}
        </div>
      </ScrollArea>

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
        <div
          ref={contextMenuRef}
          className="fixed z-50 bg-popover text-popover-foreground rounded-md border shadow-md py-1 min-w-[160px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            className="w-full px-3 py-1.5 text-sm text-left hover:bg-accent hover:text-accent-foreground flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={() => {
              copySelection('text');
              setContextMenu(null);
            }}
            disabled={selectionStart === null}
          >
            <Copy className="h-4 w-4" />
            Copy Text
          </button>
          <button
            className="w-full px-3 py-1.5 text-sm text-left hover:bg-accent hover:text-accent-foreground flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={() => {
              copySelection('hex');
              setContextMenu(null);
            }}
            disabled={selectionStart === null}
          >
            <Copy className="h-4 w-4" />
            Copy Hex
          </button>
          <button
            className="w-full px-3 py-1.5 text-sm text-left hover:bg-accent hover:text-accent-foreground flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={() => {
              copySelection('dump');
              setContextMenu(null);
            }}
            disabled={selectionStart === null}
          >
            <Copy className="h-4 w-4" />
            Copy Dump
          </button>
          <div className="border-t border-border my-1" />
          <button
            className="w-full px-3 py-1.5 text-sm text-left hover:bg-accent hover:text-accent-foreground flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={() => {
              pasteBytes();
              setContextMenu(null);
            }}
            disabled={selectionStart === null}
          >
            <ClipboardPaste className="h-4 w-4" />
            Paste
          </button>
        </div>
      )}
    </div>
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
  refresh: () => void;
  isLoading: boolean;
  pendingChanges: Map<number, number>;
  applyPendingChanges: () => void;
  discardPendingChanges: () => void;
}

function HexToolbar({
  addressInput,
  setAddressInput,
  handleAddressKeyDown,
  handleGoto,
  viewMode,
  setViewMode,
  refresh,
  isLoading,
  pendingChanges,
  applyPendingChanges,
  discardPendingChanges,
}: HexToolbarProps) {
  return (
    <div className="flex items-center gap-2 p-2 border-b border-border bg-muted/30">
      {/* Address input */}
      <div className="flex items-center gap-2">
        <Input
          placeholder="rsp, rax+0x10, symbol..."
          value={addressInput}
          onChange={(e) => setAddressInput(e.target.value)}
          onKeyDown={handleAddressKeyDown}
        />
        <Button
          variant="outline"
          onClick={handleGoto}
          title="Go to address"
        >
          <ArrowRight />
          <span>Go</span>
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

      {/* Refresh */}
      <Button
        variant="outline"
        onClick={refresh}
        disabled={isLoading}
        title="Refresh memory"
      >
        <RefreshCw className={`h-3 w-3 ${isLoading ? "animate-spin" : ""}`} />
      </Button>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Pending changes actions */}
      {pendingChanges.size > 0 && (
        <div className="flex items-center gap-1">
          <span className="text-xs text-yellow-600 dark:text-yellow-400">
            {pendingChanges.size} pending
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={applyPendingChanges}
            className="h-7 px-2 rounded-sm"
            title="Apply changes"
          >
            <Save className="h-3 w-3" />
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={discardPendingChanges}
            className="h-7 px-2 rounded-sm"
            title="Discard changes"
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      )}
    </div>
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
