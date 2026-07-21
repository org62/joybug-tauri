import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo, KeyboardEvent, MouseEvent, UIEvent, WheelEvent } from "react";
import { Virtualizer } from "@tanstack/react-virtual";
import { VirtualizedList } from "./ui/virtualized-list";
import { Button } from "./ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { Binary, Save, X, ArrowRight, Copy, ClipboardPaste, Crosshair, Bookmark, Fingerprint, HardDrive } from "lucide-react";
import { useHexEditor, ExtendStatus, HexDataSource } from "@/hooks/useHexEditor";
import { isProcessAvailable } from "@/lib/sessionHelpers";
import { CHANGED_VALUE_CLASS } from "@/lib/utils";
import { useNavigationChannel } from "@/hooks/useNavigationChannel";
import { memoryNavigation } from "@/lib/navigationStore";
import {
  ViewMode,
  VIEW_MODE_CONFIGS,
  formatAddress,
  byteToAscii,
  BYTES_PER_ROW,
  DEFAULT_CHUNK_SIZE,
  RegisterContext,
  SymbolResolver,
} from "@/lib/hexUtils";
import { AddressExpressionInput } from "@/components/AddressExpressionInput";
import { PointerDereferenceDisplay } from "@/components/DereferenceDisplay";
import { DockPanel, PanelToolbar, PanelFooter } from "@/components/ui/panel";
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
  onFindAccesses?: (address: string, mode: "Write" | "ReadWrite", size: number) => void;
  /** Highlight the memory region containing an address (context-menu action). */
  onShowInMemoryRegions?: (address: string) => void;
  // Non-session byte source (e.g. a PE file on disk). When set, the view reads
  // and writes through it instead of session memory commands.
  dataSource?: HexDataSource;
  // Overrides how absolute addresses (baseAddress + offset) render in the gutter
  // and footer — used by the PE viewer to show VA / RVA / file-offset per mode.
  addressFormatter?: (absoluteAddress: bigint) => string;
  // Reinterprets a goto-box address before navigating (PE viewer: map a VA or
  // an RVA typed per the address mode to the file offset this view needs).
  translateGotoInput?: (address: bigint) => bigint;
}

const VIEWMODE_VALUE_TYPE: Record<ViewMode, string> = {
  byte: 'U8', word: 'U16', dword: 'U32', qword: 'U64', float: 'F32', pointer: 'U64',
};

const ROW_HEIGHT = 28;
// Scrolling within this distance of the top/bottom edge extends the memory
// window in that direction (infinite scroll).
const EDGE_EXTEND_THRESHOLD = ROW_HEIGHT * 6;
// Cap on how far a wheel-at-edge extension may auto-scroll into the fetched
// rows: at most one full chunk's worth of rows.
const MAX_WHEEL_REVEAL = (DEFAULT_CHUNK_SIZE / BYTES_PER_ROW) * ROW_HEIGHT;

export function HexView({ sessionId, memoryViewId, sessionStatus, registers = {}, resolveSymbol, initialAddress, initialViewMode, onSetHardwareBreakpoint, onAddBookmark, onFindAccesses, onShowInMemoryRegions, dataSource, addressFormatter, translateGotoInput }: HexViewProps) {
  const fmtAddr = addressFormatter ?? formatAddress;
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
    // Window boundaries
    topExhausted,
    bottomExhausted,
    viewGeneration,
    viewTargetOffset,
    extendStatus,
    // Actions
    goToAddress,
    setViewMode,
    // Window extension
    extendUp,
    extendDown,
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
  } = useHexEditor({ sessionId, memoryViewId, sessionStatus, registers, resolveSymbol, initialAddress, initialViewMode, dataSource });

  const [addressInput, setAddressInput] = useState("");
  const hexViewContainerRef = useRef<HTMLDivElement>(null);

  // External navigation (e.g., from symbol click or "Go to Memory"); object
  // payloads carry a byte range to select at the target (PE field spans).
  useNavigationChannel(memoryNavigation, (payload) =>
    typeof payload === "string" ? goToAddress(payload) : goToAddress(payload.address, payload.selectLength));

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

  // Handle goto address (expression already resolved by AddressExpressionInput)
  const handleAddressResolved = (address: bigint) => {
    goToAddress(translateGotoInput ? translateGotoInput(address) : address);
    setAddressInput("");
  };

  // Calculate rows
  const config = VIEW_MODE_CONFIGS[viewMode];
  // For pointer mode: 1 pointer per row (8 bytes), otherwise use standard 16 bytes per row
  const bytesPerRow = viewMode === 'pointer' ? config.bytesPerUnit : BYTES_PER_ROW;
  const unitsPerRow = viewMode === 'pointer' ? 1 : Math.floor(BYTES_PER_ROW / config.bytesPerUnit);
  const totalRows = Math.ceil(memoryData.length / bytesPerRow);
  const rowIndices = useMemo(() => Array.from({ length: totalRows }, (_, i) => i), [totalRows]);
  const virtualizerRef = useRef<Virtualizer<HTMLDivElement, Element> | null>(null);

  // Minimum row width: below this the view scrolls horizontally instead of
  // wrapping/squeezing columns. ch units resolve against the mono font set on
  // both the header inner div and the VirtualizedList. The terms mirror the
  // row markup: 9rem = w-36 address column, 16px = px-2 row padding, 136px =
  // w-[136px] ascii column, 8px/unit = gap-x-1 + px-0.5 slack — keep in sync.
  const rowMinWidth = viewMode === 'pointer'
    // address + row padding + pointer value + floor for the deref chain
    ? `calc(9rem + 16px + ${config.displayWidth}ch + 12rem)`
    : `calc(9rem + 16px + 136px + ${unitsPerRow * config.displayWidth}ch + ${unitsPerRow * 8}px)`;

  // Keep the fixed column header horizontally aligned with the scrolled rows,
  // and extend the memory window when scrolling near a vertical edge.
  const headerInnerRef = useRef<HTMLDivElement>(null);
  const lastScrollLeft = useRef(0);
  const handleViewportScroll = useCallback((e: UIEvent<HTMLDivElement>) => {
    const { scrollLeft, scrollTop, scrollHeight, clientHeight } = e.currentTarget;
    if (scrollTop < EDGE_EXTEND_THRESHOLD) extendUp();
    if (scrollHeight - scrollTop - clientHeight < EDGE_EXTEND_THRESHOLD) extendDown();
    // Vertical scrolling is the hot path — skip the style write unless the
    // horizontal offset actually changed.
    if (scrollLeft === lastScrollLeft.current) return;
    lastScrollLeft.current = scrollLeft;
    if (headerInnerRef.current) {
      headerInnerRef.current.style.transform = `translateX(-${scrollLeft}px)`;
    }
  }, [extendUp, extendDown]);
  useEffect(() => {
    lastScrollLeft.current = 0;
    if (headerInnerRef.current) {
      headerInnerRef.current.style.transform = "translateX(0)";
    }
  }, [rowMinWidth]);

  // Wheeling while pinned at an edge produces no scroll event — catch it here
  // so the window still extends (e.g. scroll up right after a goto). The wheel
  // distance is remembered so the view scrolls into the fetched rows once they
  // arrive; otherwise the scroll anchor keeps the content visually frozen and
  // the user has to wheel a second time to see anything happen.
  const pendingRevealRef = useRef(0);
  const handleWheel = useCallback((e: WheelEvent<HTMLDivElement>) => {
    const viewport = virtualizerRef.current?.scrollElement;
    if (!viewport) return;
    if (e.deltaY < 0 && viewport.scrollTop <= 0) {
      if (extendUp()) {
        pendingRevealRef.current = e.deltaY;
      } else if (pendingRevealRef.current < 0) {
        // Fetch already in flight — keep accumulating the wheel distance
        pendingRevealRef.current = Math.max(pendingRevealRef.current + e.deltaY, -MAX_WHEEL_REVEAL);
      }
    } else if (e.deltaY > 0 && viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 1) {
      if (extendDown()) {
        pendingRevealRef.current = e.deltaY;
      } else if (pendingRevealRef.current > 0) {
        pendingRevealRef.current = Math.min(pendingRevealRef.current + e.deltaY, MAX_WHEEL_REVEAL);
      }
    }
  }, [extendUp, extendDown]);

  // Keep the scroll position meaningful across window changes:
  // - goto (viewGeneration bump): scroll to the target row — again once the
  //   replace read lands, since the first attempt clamps to the old content
  // - window base moved (prepend/trim): anchor so content stays put, plus any
  //   remembered wheel-at-edge distance to reveal the fetched rows
  // - pure append while pinned at the bottom: apply the remembered wheel distance
  const prevWindowRef = useRef({ base: baseAddress, generation: viewGeneration, data: memoryData });
  const gotoTargetRowRef = useRef<number | null>(null);
  useLayoutEffect(() => {
    const prev = prevWindowRef.current;
    prevWindowRef.current = { base: baseAddress, generation: viewGeneration, data: memoryData };

    const isNewGeneration = viewGeneration !== prev.generation;
    if (isNewGeneration) {
      pendingRevealRef.current = 0;
      gotoTargetRowRef.current = Math.floor(viewTargetOffset / bytesPerRow);
    }
    const virtualizer = virtualizerRef.current;
    const viewport = virtualizer?.scrollElement;
    // No list rendered yet (goto from an empty view) — the goto scroll stays
    // pending in gotoTargetRowRef until the replace read lands.
    if (!virtualizer || !viewport) return;
    const isNewData = memoryData !== prev.data;
    if (!isNewGeneration && !isNewData) return;

    if (gotoTargetRowRef.current !== null) {
      // Scroll to the goto target row. On the generation bump the replace
      // read usually hasn't landed (scroll clamps to the old content), so
      // repeat when the data arrives and finish there.
      virtualizer.scrollToOffset(gotoTargetRowRef.current * ROW_HEIGHT);
      if (!isNewGeneration && isNewData) gotoTargetRowRef.current = null;
      return;
    }
    const deltaBytes = Number(prev.base - baseAddress);
    if (deltaBytes !== 0) {
      const anchored = viewport.scrollTop + (deltaBytes / bytesPerRow) * ROW_HEIGHT + pendingRevealRef.current;
      pendingRevealRef.current = 0;
      virtualizer.scrollToOffset(Math.max(0, anchored));
    } else if (pendingRevealRef.current !== 0) {
      virtualizer.scrollToOffset(viewport.scrollTop + pendingRevealRef.current);
      pendingRevealRef.current = 0;
    }
  }, [baseAddress, viewGeneration, bytesPerRow, memoryData, viewTargetOffset]);

  // Empty state — no byte source at all (no session and no file).
  if (!sessionId && !dataSource) {
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

  // Check if the view can interact with bytes. A file data-source is always
  // active; for a session this includes the non-invasive Open session, which
  // reads memory over OOB without a debug loop.
  const isSessionActive = dataSource ? true : isProcessAvailable(sessionStatus);

  if (memoryData.length === 0 && !isLoading && !error) {
    // If session is active, show toolbar so user can enter address
    if (isSessionActive) {
      return (
        <DockPanel>
          <HexToolbar
            addressInput={addressInput}
            setAddressInput={setAddressInput}
            onResolveAddress={handleAddressResolved}
            registers={registers}
            resolveSymbol={resolveSymbol}
            sessionId={sessionId}
            memoryViewId={memoryViewId}
            viewMode={viewMode}
            setViewMode={setViewMode}
            pendingChanges={pendingChanges}
            applyPendingChanges={applyPendingChanges}
            discardPendingChanges={discardPendingChanges}
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
          onResolveAddress={handleAddressResolved}
          registers={registers}
          resolveSymbol={resolveSymbol}
          sessionId={sessionId}
          memoryViewId={memoryViewId}
          viewMode={viewMode}
          setViewMode={setViewMode}
          pendingChanges={pendingChanges}
          applyPendingChanges={applyPendingChanges}
          discardPendingChanges={discardPendingChanges}
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
      data-testid="hex-panel"
      className="outline-none"
      tabIndex={0}
      onKeyDown={handleContainerKeyDown}
    >
      {/* Toolbar - Fixed */}
      <HexToolbar
        addressInput={addressInput}
        setAddressInput={setAddressInput}
        onResolveAddress={handleAddressResolved}
        registers={registers}
        resolveSymbol={resolveSymbol}
        sessionId={sessionId}
        viewMode={viewMode}
        setViewMode={setViewMode}
        pendingChanges={pendingChanges}
        applyPendingChanges={applyPendingChanges}
        discardPendingChanges={discardPendingChanges}
      />

      {/* Column Header - Fixed vertically, follows horizontal scroll */}
      <div className="shrink-0 overflow-hidden border-b border-border">
        <div
          ref={headerInnerRef}
          style={{ minWidth: rowMinWidth }}
          className="flex items-center font-mono text-sm px-2 pt-2 pb-1 text-muted-foreground"
        >
          <span className="w-36 shrink-0 text-xs">Address</span>
          <span className="flex-1 text-xs">{viewMode === 'pointer' ? 'Pointer' : 'Hex'}</span>
          {viewMode !== 'pointer' && (
            <span className="w-[136px] shrink-0 text-right pr-2 text-xs">ASCII</span>
          )}
        </div>
      </div>

      {/* Hex Data - Scrollable + Virtualized */}
      <div className="flex-1 min-h-0" onContextMenu={(e) => openContextMenu(e, {})} onWheel={handleWheel}>
        <VirtualizedList
          items={rowIndices}
          rowHeight={ROW_HEIGHT}
          className="h-full font-mono text-sm"
          minContentWidth={rowMinWidth}
          onViewportScroll={handleViewportScroll}
          virtualizerRef={virtualizerRef}
          renderItem={(rowIndex) => {
            const rowOffset = rowIndex * bytesPerRow;
            const rowAddress = baseAddress + BigInt(rowOffset);
            const rowBytes = memoryData.slice(rowOffset, rowOffset + bytesPerRow);

            return (
              <div className="flex items-center hover:bg-muted/30 h-full px-2 select-none">
                {/* Address column */}
                <span className="w-36 shrink-0 text-muted-foreground text-xs">
                  {fmtAddr(rowAddress)}
                </span>

                {/* Hex values column */}
                <div className="flex-1 flex gap-x-1 min-w-0">
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
                        className="inline-flex items-center gap-1 min-w-0"
                      >
                        <span
                          data-changed={hasChangedByte || undefined}
                          className={`cursor-pointer rounded px-0.5 inline-block text-center ${
                            isSelected
                              ? "bg-primary text-primary-foreground"
                              : hasPendingChange
                              ? "bg-yellow-200 dark:bg-yellow-800"
                              : hasChangedByte
                              ? `${CHANGED_VALUE_CLASS} hover:bg-muted/50`
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
                          data-changed={hasChanged || undefined}
                          className={`cursor-pointer ${
                            isSelected
                              ? "bg-primary text-primary-foreground"
                              : hasPending
                              ? "bg-yellow-200 dark:bg-yellow-800"
                              : hasChanged
                              ? CHANGED_VALUE_CLASS
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
          topExhausted={topExhausted}
          bottomExhausted={bottomExhausted}
          extendStatus={extendStatus}
          addressFormatter={fmtAddr}
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
                await navigator.clipboard.writeText(fmtAddr(address));
              }
            }}
            disabled={selectionStart === null}
          >
            Copy Address
          </ContextMenuItem>
          {onShowInMemoryRegions && (
            <ContextMenuItem
              icon={<HardDrive />}
              disabled={selectionStart === null}
              onClick={() => {
                if (selectionStart === null) return;
                const address = baseAddress + BigInt(selectionStart);
                onShowInMemoryRegions(`0x${address.toString(16)}`);
              }}
            >
              Go to Memory Region
            </ContextMenuItem>
          )}
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
          {(onSetHardwareBreakpoint || onFindAccesses) && selectionStart !== null && (() => {
            const address = baseAddress + BigInt(selectionStart);
            const selSize = selectionEnd !== null ? Math.abs(selectionEnd - selectionStart) + 1 : 1;
            const hwSize = selSize >= 8 ? 8 : selSize >= 4 ? 4 : selSize >= 2 ? 2 : 1;
            const addrStr = `0x${address.toString(16)}`;
            return (
              <>
                {onSetHardwareBreakpoint && (
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
                )}
                {onFindAccesses && (
                  <>
                    <ContextMenuSeparator />
                    <ContextMenuItem
                      icon={<Fingerprint />}
                      onClick={() => onFindAccesses(addrStr, "Write", hwSize)}
                    >
                      Find what writes to this address ({hwSize}B)
                    </ContextMenuItem>
                    <ContextMenuItem
                      icon={<Fingerprint />}
                      onClick={() => onFindAccesses(addrStr, "ReadWrite", hwSize)}
                    >
                      Find what accesses (read/write) ({hwSize}B)
                    </ContextMenuItem>
                  </>
                )}
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
  onResolveAddress: (address: bigint) => void;
  registers?: RegisterContext;
  resolveSymbol?: SymbolResolver;
  sessionId?: string;
  /** Dock tab id of this hex view, so "Go to Memory" focuses the right one. */
  memoryViewId?: string;
  viewMode: ViewMode;
  setViewMode: (mode: ViewMode) => void;
  pendingChanges: Map<number, number>;
  applyPendingChanges: () => void;
  discardPendingChanges: () => void;
}

function HexToolbar({
  addressInput,
  setAddressInput,
  onResolveAddress,
  registers,
  resolveSymbol,
  sessionId,
  memoryViewId,
  viewMode,
  setViewMode,
  pendingChanges,
  applyPendingChanges,
  discardPendingChanges,
}: HexToolbarProps) {
  return (
    <PanelToolbar>
      {/* Address input */}
      <AddressExpressionInput
        value={addressInput}
        onChange={setAddressInput}
        onResolve={onResolveAddress}
        registers={registers}
        resolveSymbol={resolveSymbol}
        sessionId={sessionId}
        focusTabId={memoryViewId}
        historyKey="hex-goto"
        buttonLabel={
          <>
            <ArrowRight />
            <span>Go</span>
          </>
        }
      />

      {/* View mode selector */}
      <Select value={viewMode} onValueChange={(v) => setViewMode(v as ViewMode)}>
        <SelectTrigger size="xs">
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
  topExhausted: boolean;
  bottomExhausted: boolean;
  extendStatus: ExtendStatus | null;
  // Already defaulted by HexView — the parent passes its resolved fmtAddr.
  addressFormatter: (absoluteAddress: bigint) => string;
}

function HexStatusBar({
  baseAddress,
  memoryData,
  selectionStart,
  selectionEnd,
  pendingChanges,
  isLoading,
  topExhausted,
  bottomExhausted,
  extendStatus,
  addressFormatter: fmtAddr,
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
    <PanelFooter className="gap-4 text-xs text-muted-foreground">
      {/* Address range */}
      <span>
        {fmtAddr(baseAddress)} - {fmtAddr(endAddress)}
      </span>

      {/* Size */}
      <span>{memoryData.length} bytes</span>

      {/* Selection info */}
      {hasSelection && (
        <span>
          {selectionCount === 1 ? (
            <>
              Cursor: {fmtAddr(baseAddress + BigInt(normalizedStart!))} (offset +0x
              {normalizedStart!.toString(16).toUpperCase()})
            </>
          ) : (
            <>
              Selected: {selectionCount} bytes at{" "}
              {fmtAddr(baseAddress + BigInt(normalizedStart!))}
            </>
          )}
        </span>
      )}

      {/* Window boundary indicators (replaces the old partial-read toast) */}
      {topExhausted && <span>▲ start of accessible memory</span>}
      {bottomExhausted && <span>▼ end of accessible memory</span>}

      {/* Edge extension feedback: fetching, then what arrived */}
      {extendStatus && (
        <span className="text-primary">
          {extendStatus.direction === 'up' ? '▲' : '▼'}{' '}
          {extendStatus.done
            ? `fetched ${extendStatus.size} bytes at ${fmtAddr(extendStatus.address)}`
            : `fetching ${fmtAddr(extendStatus.address)}…`}
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
    </PanelFooter>
  );
}
