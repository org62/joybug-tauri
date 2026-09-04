import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo, memo, KeyboardEvent, MouseEvent, UIEvent, WheelEvent } from "react";
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
import { Binary, Save, X, ArrowRight, Copy, ClipboardPaste, Crosshair, Bookmark, Fingerprint, HardDrive, Tag } from "lucide-react";
import { useHexEditor, ExtendStatus, HexDataSource } from "@/hooks/useHexEditor";
import { useHexSymbols, HexSymbolSource, HexExtraLabel } from "@/hooks/useHexSymbols";
import { useLocalStorageState } from "@/hooks/useLocalStorageState";
import { buildHexRows, dataRowForOffset, displayIndexForOffset, HexRow } from "@/lib/hexRows";
import { TruncatedSymbol } from "@/components/ui/truncated-symbol";
import { isProcessAvailable } from "@/lib/sessionHelpers";
import { CHANGED_VALUE_CLASS, DATA_ROW_HEIGHT } from "@/lib/utils";
import { useNavigationChannel } from "@/hooks/useNavigationChannel";
import { memoryNavigation } from "@/lib/navigationStore";
import {
  ViewMode,
  viewModeConfig,
  pointerIntegerMode,
  formatAddress,
  formatSignedOffset,
  byteToAscii,
  BYTES_PER_ROW,
  DEFAULT_CHUNK_SIZE,
  RegisterContext,
  SymbolResolver,
} from "@/lib/hexUtils";
import { AddressExpressionInput } from "@/components/AddressExpressionInput";
import { PointerDereferenceDisplay } from "@/components/DereferenceDisplay";
import { DockPanel, PanelToolbar, PanelFooter } from "@/components/ui/panel";
import { ProcessUnavailableState } from "@/components/ui/empty-state";
import { ContextMenu, ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { useContextMenu } from "@/hooks/useContextMenu";
import { useHeaderScrollSync } from "@/hooks/useHeaderScrollSync";

interface HexViewProps {
  sessionId?: string;
  memoryViewId?: string;
  sessionStatus?: string;
  registers?: RegisterContext;
  resolveSymbol?: SymbolResolver;
  initialAddress?: bigint;
  initialViewMode?: ViewMode;
  /** Changes when background symbol loading completes — re-resolves pointer-mode annotations. */
  symbolsRefreshKey?: string;
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
  /** Re-centre on this address (and make it the offset origin) whenever
   *  `followKey` changes — the Stack tab passes RSP + a per-pause key. */
  followAddress?: bigint;
  followKey?: string;
  /** "shared" (default) claims the global "Go to Memory" channel; "private"
   *  opts an embedded view (the Stack tab) out of it, leaving the payload for
   *  the Memory tab(s). */
  navScope?: "shared" | "private";
  /** Module symbols inside a window, for the "show symbols" rows. Absent in
   *  file (dataSource) mode, which also hides the toggle. */
  symbolSource?: HexSymbolSource;
  /** Host-known labels (bookmarks) merged into the symbol rows. */
  extraLabels?: HexExtraLabel[];
  /** Target pointer width in bytes: 4 for a WOW64 process. Sizes `pointer`
   *  mode units, the dereference stride and the default address width. */
  pointerSize?: number;
}

const VIEWMODE_VALUE_TYPE: Record<ViewMode, string> = {
  byte: 'U8', word: 'U16', dword: 'U32', qword: 'U64', float: 'F32', pointer: 'U64',
};

const ROW_HEIGHT = DATA_ROW_HEIGHT;
// Scrolling within this distance of the top/bottom edge extends the memory
// window in that direction (infinite scroll).
const EDGE_EXTEND_THRESHOLD = ROW_HEIGHT * 6;
// Cap on how far a wheel-at-edge extension may auto-scroll into the fetched
// rows: at most one full chunk's worth of rows.
const MAX_WHEEL_REVEAL = (DEFAULT_CHUNK_SIZE / BYTES_PER_ROW) * ROW_HEIGHT;

// navScope="private": subscribe to the shared memory channel but never claim a
// payload, so an embedded view can't swallow a "Go to Memory" meant for a Memory tab.
const CLAIM_NOTHING = () => false;

export function HexView({ sessionId, memoryViewId, sessionStatus, registers = {}, resolveSymbol, initialAddress, initialViewMode, symbolsRefreshKey, onSetHardwareBreakpoint, onAddBookmark, onFindAccesses, onShowInMemoryRegions, dataSource, addressFormatter, translateGotoInput, followAddress, followKey, navScope, symbolSource, extraLabels, pointerSize = 8 }: HexViewProps) {
  // Stable identity: feeds the gutterLabel useCallback below.
  const fmtAddr = useMemo(
    () => addressFormatter ?? ((a: bigint) => formatAddress(a, pointerSize * 2)),
    [addressFormatter, pointerSize],
  );
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
    offsetOrigin,
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
    toggleOffsetOrigin,
  } = useHexEditor({ sessionId, memoryViewId, sessionStatus, registers, resolveSymbol, initialAddress, initialViewMode, dataSource, symbolsRefreshKey, followAddress, followKey });

  const [addressInput, setAddressInput] = useState("");
  const hexViewContainerRef = useRef<HTMLDivElement>(null);

  // "Show symbols": one app-wide preference, like the register/stack toggles.
  // Only offered when the host supplies a symbol source (session views); the
  // fetch itself is gated on a live process per the session-state policy.
  const [showSymbols, setShowSymbols] = useLocalStorageState<boolean>("hex.showSymbols", false);
  const toggleSymbols = useCallback(() => setShowSymbols((v) => !v), [setShowSymbols]);
  const symbolsEnabled = showSymbols && !!symbolSource && !dataSource && isProcessAvailable(sessionStatus);
  const symbols = useHexSymbols({
    source: symbolSource,
    enabled: symbolsEnabled,
    baseAddress,
    length: memoryData.length,
    refreshKey: symbolsRefreshKey,
    extra: extraLabels,
  });

  // External navigation (e.g., from symbol click or "Go to Memory"); object
  // payloads carry a byte range to select at the target (PE field spans).
  useNavigationChannel(
    memoryNavigation,
    (payload) => (typeof payload === "string" ? goToAddress(payload) : goToAddress(payload.address, payload.selectLength)),
    navScope === "private" ? CLAIM_NOTHING : undefined,
  );

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
    const config = viewModeConfig(viewMode, pointerSize);
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
  const config = viewModeConfig(viewMode, pointerSize);
  // For pointer mode: 1 pointer per row (8 bytes), otherwise use standard 16 bytes per row
  const bytesPerRow = viewMode === 'pointer' ? config.bytesPerUnit : BYTES_PER_ROW;
  const unitsPerRow = viewMode === 'pointer' ? 1 : Math.floor(BYTES_PER_ROW / config.bytesPerUnit);
  const totalRows = Math.ceil(memoryData.length / bytesPerRow);
  // Display rows: data rows split around the symbol rows interleaved into
  // them. With symbols off this is the identity mapping (see hexRows.ts).
  const rowModel = useMemo(
    () => buildHexRows(totalRows, bytesPerRow, config.bytesPerUnit, unitsPerRow, baseAddress, symbols),
    [totalRows, bytesPerRow, config.bytesPerUnit, unitsPerRow, baseAddress, symbols],
  );
  // Invisible text that gives a blank placeholder the exact width of a data
  // cell: a cell is `max(displayWidth ch, content + padding)`, so fixed-width
  // modes need `displayWidth` glyphs of content here and float (whose values
  // are always narrower than its minWidth) needs none. Used by symbol rows
  // and by the units a data-row fragment doesn't show.
  const ghost = useMemo(
    () => (viewMode === "float" ? "" : "0".repeat(config.displayWidth)),
    [viewMode, config.displayWidth],
  );
  // How the gutter renders an address — absolute, or measured from the user's
  // origin. Shared by the data rows and the symbol rows so the two columns
  // can't disagree about which anchor is in effect.
  const gutterLabel = useCallback(
    (address: bigint) => (offsetOrigin === null ? fmtAddr(address) : formatSignedOffset(address - offsetOrigin)),
    [offsetOrigin, fmtAddr],
  );
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
  const { headerInnerRef, syncScrollLeft } = useHeaderScrollSync(
    rowMinWidth,
    () => virtualizerRef.current?.scrollElement,
  );
  const handleViewportScroll = useCallback((e: UIEvent<HTMLDivElement>) => {
    const { scrollTop, scrollHeight, clientHeight } = e.currentTarget;
    if (scrollTop < EDGE_EXTEND_THRESHOLD) extendUp();
    if (scrollHeight - scrollTop - clientHeight < EDGE_EXTEND_THRESHOLD) extendDown();
    syncScrollLeft(e.currentTarget.scrollLeft);
  }, [extendUp, extendDown, syncScrollLeft]);

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

  // Keep the scroll position meaningful across window and row-model changes:
  // - goto (viewGeneration bump): scroll to the target row — again once the
  //   replace read lands, since the first attempt clamps to the old content
  // - window base moved (prepend/trim): anchor so content stays put, plus any
  //   remembered wheel-at-edge distance to reveal the fetched rows
  // - pure append while pinned at the bottom: apply the remembered wheel distance
  // - symbol rows inserted/removed (fetch landed, toggle, symbols reloaded) or
  //   bytesPerRow changed with the view mode: same anchor, no reveal
  // All cases share one rule: the data row under the viewport top, located in
  // the previous row model, is re-located in the new one by window byte offset.
  // With no symbol rows this is exactly `scrollTop + (deltaBytes / bytesPerRow) * ROW_HEIGHT`.
  const prevWindowRef = useRef({ base: baseAddress, generation: viewGeneration, data: memoryData, model: rowModel, bytesPerRow });
  // Goto target as a window byte offset, resolved through whichever row model
  // is current on each run (symbol rows may land between the two attempts).
  const gotoTargetOffsetRef = useRef<number | null>(null);
  useLayoutEffect(() => {
    const prev = prevWindowRef.current;
    prevWindowRef.current = { base: baseAddress, generation: viewGeneration, data: memoryData, model: rowModel, bytesPerRow };

    const isNewGeneration = viewGeneration !== prev.generation;
    if (isNewGeneration) {
      pendingRevealRef.current = 0;
      gotoTargetOffsetRef.current = viewTargetOffset;
    }
    const virtualizer = virtualizerRef.current;
    const viewport = virtualizer?.scrollElement;
    // No list rendered yet (goto from an empty view) — the goto scroll stays
    // pending in gotoTargetOffsetRef until the replace read lands.
    if (!virtualizer || !viewport) return;
    const isNewData = memoryData !== prev.data;
    const isNewModel = rowModel !== prev.model;
    if (!isNewGeneration && !isNewData && !isNewModel) return;

    if (gotoTargetOffsetRef.current !== null) {
      // Scroll to the goto target row. On the generation bump the replace
      // read usually hasn't landed (scroll clamps to the old content), so
      // repeat when the data arrives and finish there.
      virtualizer.scrollToOffset(displayIndexForOffset(rowModel, gotoTargetOffsetRef.current, bytesPerRow) * ROW_HEIGHT);
      if (!isNewGeneration && isNewData) gotoTargetOffsetRef.current = null;
      return;
    }

    if (rowModel.rows.length === 0 || prev.model.rows.length === 0) return;
    const scrollTop = viewport.scrollTop;
    const topDisplay = Math.min(Math.floor(scrollTop / ROW_HEIGHT), prev.model.rows.length - 1);
    const topRow = prev.model.rows[topDisplay];
    const remainder = scrollTop - topDisplay * ROW_HEIGHT;
    // Rows into the top row's group (0 = its first symbol row), kept so a group
    // that merely grew or shrank doesn't shift what the user was looking at.
    const within = topDisplay - prev.model.displayStart[topRow.dataRow];
    const anchorBytes = topRow.dataRow * prev.bytesPerRow + Number(prev.base - baseAddress);
    const dNew = dataRowForOffset(rowModel, anchorBytes, bytesPerRow);
    const groupStart = rowModel.displayStart[dNew];
    const groupSize = rowModel.displayStart[dNew + 1] - groupStart;
    // The wheel-at-edge distance reveals fetched *bytes*; spend it only when the
    // window itself changed, never when a symbol fetch happens to land first.
    const reveal = isNewData ? pendingRevealRef.current : 0;
    if (isNewData) pendingRevealRef.current = 0;
    const newTop = Math.max(0, (groupStart + Math.min(within, groupSize - 1)) * ROW_HEIGHT + remainder + reveal);
    if (Math.abs(newTop - scrollTop) >= 0.5) virtualizer.scrollToOffset(newTop);
  }, [baseAddress, viewGeneration, bytesPerRow, memoryData, viewTargetOffset, rowModel]);

  // The toolbar is identical in every state that renders one (loaded, empty
  // and error), so build it once — three copies of a 14-prop element drift the
  // moment one gains a prop.
  const toolbar = (
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
      showSymbols={showSymbols}
      onToggleSymbols={symbolSource ? toggleSymbols : undefined}
      discardPendingChanges={discardPendingChanges}
    />
  );

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
          {toolbar}
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

    // No process (session Stopped / not started) — the shared no-process state.
    return (
      <DockPanel>
        <ProcessUnavailableState icon={Binary} what="Memory" />
      </DockPanel>
    );
  }

  if (error) {
    // Show toolbar so user can try a different address
    return (
      <DockPanel>
        {toolbar}
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
      data-memory-view-id={memoryViewId}
      className="outline-none"
      tabIndex={0}
      onKeyDown={handleContainerKeyDown}
    >
      {/* Toolbar - Fixed */}
      {toolbar}

      {/* Column Header - Fixed vertically, follows horizontal scroll */}
      <div className="shrink-0 overflow-hidden border-b border-border">
        <div
          ref={headerInnerRef}
          style={{ minWidth: rowMinWidth }}
          className="flex items-center font-mono text-sm px-2 pt-2 pb-1 text-muted-foreground"
        >
          <span className={`w-36 shrink-0 text-xs ${offsetOrigin === null ? "" : "text-right pr-3"}`}>
            {offsetOrigin === null ? "Address" : "Offset"}
          </span>
          <span className="flex-1 text-xs">{viewMode === 'pointer' ? 'Pointer' : 'Hex'}</span>
          {viewMode !== 'pointer' && (
            <span className="w-[136px] shrink-0 text-right pr-2 text-xs">ASCII</span>
          )}
        </div>
      </div>

      {/* Hex Data - Scrollable + Virtualized */}
      <div className="flex-1 min-h-0" onContextMenu={(e) => openContextMenu(e, {})} onWheel={handleWheel}>
        <VirtualizedList
          items={rowModel.rows}
          rowHeight={ROW_HEIGHT}
          className="h-full font-mono text-data"
          minContentWidth={rowMinWidth}
          onViewportScroll={handleViewportScroll}
          virtualizerRef={virtualizerRef}
          renderItem={(row) => {
            if (row.kind === "symbol") {
              return (
                <HexSymbolRow
                  row={row}
                  displayWidth={config.displayWidth}
                  ghost={ghost}
                  gutterText={gutterLabel(row.address)}
                  gutterRight={offsetOrigin !== null}
                />
              );
            }
            const rowIndex = row.dataRow;
            const rowOffset = rowIndex * bytesPerRow;
            const rowAddress = baseAddress + BigInt(rowOffset);
            const rowBytes = memoryData.slice(rowOffset, rowOffset + bytesPerRow);
            // A fragment (row split around a symbol) shows only its own unit
            // range; the other cells stay as blanks so columns line up. The
            // continuation fragment repeats the row address, dimmed.
            const isContinuation = row.unitFrom > 0;
            const inFragment = (unitIndex: number) => unitIndex >= row.unitFrom && unitIndex < row.unitTo;
            const byteInFragment = (byteInRow: number) => inFragment(Math.floor(byteInRow / config.bytesPerUnit));

            return (
              <div className="flex items-center hover:bg-muted/30 h-full px-2 select-none">
                {/* Address column — double-click to measure from this row.
                    Deliberately not `cursor-pointer`: the e2e suite finds the
                    first byte cell with `span.cursor-pointer`, and the gutter
                    comes first in DOM order. */}
                <span
                  className={`w-36 shrink-0 hover:text-foreground ${
                    isContinuation ? "text-muted-foreground/50" : "text-muted-foreground"
                  } ${offsetOrigin === null ? "" : "text-right pr-3"}`}
                  data-testid="hex-address"
                  data-address={rowAddress.toString()}
                  data-unit-from={row.unitFrom}
                  data-unit-to={row.unitTo}
                  title={
                    offsetOrigin === rowAddress
                      ? "Double-click to show absolute addresses again"
                      : "Double-click to measure offsets from this address"
                  }
                  onDoubleClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    toggleOffsetOrigin(rowAddress);
                  }}
                >
                  {gutterLabel(rowAddress)}
                </span>

                {/* Hex values column */}
                <div className="flex-1 flex gap-x-1 min-w-0">
                  {Array.from({ length: unitsPerRow }).map((_, unitIndex) => {
                    const unitOffset = rowOffset + unitIndex * config.bytesPerUnit;
                    const unitBytes = memoryData.slice(
                      unitOffset,
                      unitOffset + config.bytesPerUnit
                    );

                    if (!inFragment(unitIndex)) {
                      return <HexBlankUnit key={unitIndex} displayWidth={config.displayWidth} ghost={ghost} />;
                    }

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
                              ? "bg-syn-state/20"
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
                      if (!byteInFragment(i)) {
                        return <span key={i} aria-hidden className="invisible">.</span>;
                      }
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
                              ? "bg-syn-state/20"
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
          offsetOrigin={offsetOrigin}
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
                  onAddBookmark(`0x${address.toString(16)}`, VIEWMODE_VALUE_TYPE[viewMode === 'pointer' ? pointerIntegerMode(pointerSize) : viewMode]);
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

// A unit cell that occupies its column without showing anything. The one
// definition of the blank cell's box: the data row's out-of-fragment units and
// the symbol row's leading padding must stay pixel-identical with a real cell,
// or a mid-row label stops lining up under its byte.
function HexBlankUnit({ displayWidth, ghost }: { displayWidth: number; ghost: string }) {
  return (
    <span aria-hidden className="inline-flex items-center gap-1 min-w-0 shrink-0">
      <span className="px-0.5 inline-block invisible" style={{ minWidth: `${displayWidth}ch` }}>
        {ghost}
      </span>
    </span>
  );
}

// Symbol row — inserted at a symbol's address: above its data row, or between
// the two fragments of that row when the address is mid-row.
// Purely presentational (no selection, edit, hover or double-click gutter), and
// deliberately without `cursor-pointer` / `data-testid="hex-address"`: the e2e
// suite finds the first byte cell by the former and walks gutter neighbours by
// the latter. Same fixed height as data rows so scroll math stays uniform.
// The columns mirror the data row's markup term for term (gutter width, unit
// padding, gap) so a mid-row label starts exactly under its byte cell.
interface HexSymbolRowProps {
  row: Extract<HexRow, { kind: "symbol" }>;
  displayWidth: number;
  /** Blank-cell filler text, see `ghost` in HexView. */
  ghost: string;
  gutterText: string;
  gutterRight: boolean;
}

const HexSymbolRow = memo(function HexSymbolRow({ row, displayWidth, ghost, gutterText, gutterRight }: HexSymbolRowProps) {
  return (
    <div
      data-testid="hex-symbol-row"
      data-address={row.address.toString()}
      className="flex items-center h-full px-2 select-none"
    >
      <span className={`w-36 shrink-0 text-muted-foreground/50 ${gutterRight ? "text-right pr-3" : ""}`}>
        {gutterText}
      </span>
      <div className="flex-1 flex gap-x-1 min-w-0">
        {Array.from({ length: row.unitIndex }, (_, i) => (
          <HexBlankUnit key={i} displayWidth={displayWidth} ghost={ghost} />
        ))}
        {/* Labels shrink but never grow: names sharing an address sit side by
            side with only the gap between them, and when the row is too
            narrow each shrinks in proportion to its full text, which is what
            MiddleTruncate cuts against (its sizer pins the basis, so a cut
            never feeds back into the budget). */}
        <span className="flex-1 flex items-center gap-x-3 min-w-0 font-semibold text-foreground/90">
          {row.labels.map((label) => (
            <span key={`${label.kind}:${label.text}`} className="inline-flex items-center gap-1 min-w-0">
              {label.kind === "bookmark" && <Bookmark className="h-3 w-3 shrink-0 text-syn-state" />}
              <TruncatedSymbol text={label.text} className="flex-auto min-w-0" />
            </span>
          ))}
        </span>
      </div>
    </div>
  );
});

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
  showSymbols: boolean;
  /** Present only when the view has a symbol source; the toggle renders iff set. */
  onToggleSymbols?: () => void;
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
  showSymbols,
  onToggleSymbols,
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
        className="flex-1 max-w-md"
        inputClassName="flex-1"
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

      {/* Symbol rows toggle — session views only */}
      {onToggleSymbols && (
        <Button
          size="icon-xs"
          variant={showSymbols ? "secondary" : "ghost"}
          aria-pressed={showSymbols}
          onClick={onToggleSymbols}
          title={showSymbols ? "Hide symbols" : "Show symbols"}
          data-testid="hex-symbols-toggle"
        >
          <Tag />
        </Button>
      )}

      {/* Spacer */}
      <div className="flex-1" />

      {/* Pending changes actions */}
      {pendingChanges.size > 0 && (
        <div className="flex items-center gap-1">
          <span className="text-xs text-syn-state">
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
  // Set while the gutter shows offsets, so the footer can name the anchor the
  // gutter is now silent about.
  offsetOrigin: bigint | null;
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
  offsetOrigin,
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

      {/* The address the gutter is measuring from — it shows only offsets now,
          so this is the one place the anchor is still spelled out. */}
      {offsetOrigin !== null && (
        <span data-testid="hex-offset-origin">
          relative to {fmtAddr(offsetOrigin)}
        </span>
      )}

      {/* Selection info */}
      {hasSelection && (
        <span>
          {selectionCount === 1 ? (
            <>
              Cursor: {fmtAddr(baseAddress + BigInt(normalizedStart!))} (
              {/* Measured from the user's origin when there is one: two
                  differently-anchored offsets on screen at once would be
                  unreadable. */}
              {offsetOrigin === null
                ? `offset +0x${normalizedStart!.toString(16).toUpperCase()}`
                : formatSignedOffset(
                    baseAddress + BigInt(normalizedStart!) - offsetOrigin,
                  )}
              )
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
        <span className="text-syn-state">
          {pendingChanges.size} unsaved changes
        </span>
      )}
    </PanelFooter>
  );
}
