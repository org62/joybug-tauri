import { useState, useRef, useEffect, useLayoutEffect, useCallback, memo } from "react";
import { VirtualizedList } from "./ui/virtualized-list";
import { DockPanel, PanelToolbar, PanelBody } from "@/components/ui/panel";
import { ContextMenu, ContextMenuItem } from "@/components/ui/context-menu";
import { TruncatedSymbol } from "@/components/ui/truncated-symbol";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Switch } from "./ui/switch";
import { Label } from "./ui/label";
import { Cpu, ArrowLeft, ArrowRight, RefreshCw, ChevronRight, Circle, CircleDot, Wrench, Copy, Bookmark, FileCode, LocateFixed } from "lucide-react";
import { sourceNavigation } from "@/lib/navigationStore";
import { cn } from "@/lib/utils";
import { useAssemblyView, Instruction, AsmDisassembleFn } from "@/hooks/useAssemblyView";
import { NavHistoryStore } from "@/lib/navHistory";
import { RegisterContext, SymbolResolver } from "@/lib/hexUtils";
import { AddressExpressionInput } from "@/components/AddressExpressionInput";
import { isBenignSessionError } from "@/lib/sessionHelpers";
import { useContextMenu } from "@/hooks/useContextMenu";
import { useColumnWidths } from "@/hooks/useColumnWidths";
import { EmulationQuickView } from "./EmulationQuickView";
import { QuickEmulationState } from "@/hooks/useQuickEmulation";
import { Virtualizer } from "@tanstack/react-virtual";
import { useKeybindingContext } from "@/contexts/KeybindingContext";
import { keyboardEventToChord } from "@/lib/keybindings";

const COLUMN_WIDTHS_KEY = "assembly-column-widths";
const NOP_PAD_KEY = "assembly-nop-pad";

type ColumnWidths = { symbol: number; bytes: number; mnemonic: number };

const DEFAULT_COLUMN_WIDTHS: ColumnWidths = { symbol: 320, bytes: 144, mnemonic: 64 };
const ASSEMBLY_ROW_HEIGHT = 24;

interface AssemblyViewProps {
  sessionId?: string;
  isPaused?: boolean;
  /** False when no target can serve disassembly requests (session stopped). */
  canLoad?: boolean;
  address?: number;
  registers?: RegisterContext;
  resolveSymbol?: SymbolResolver;
  breakpointAddresses?: Set<string>;
  /** Quick-emulation state (session hosts only) — enables the footer and
   * executed-row highlighting. The PE viewer passes nothing. */
  emulation?: QuickEmulationState;
  onToggleBreakpoint?: (address: string) => void;
  onSetHardwareBreakpoint?: (address: string, hwType: string, hwSize: number) => void;
  onAssemblePatch?: (address: string, assemblyText: string, nopPad?: boolean) => Promise<string | null>;
  onAddBookmark?: (address: string, asmText: string) => void;
  symbolsRefreshKey?: string;
  /** Activate the Source tab and reveal an address's source line (context-menu action). */
  onNavigateToSource?: (address: string) => void;
  /** Non-session disassembly source (PE file on disk). Addresses are VAs. */
  disassemble?: AsmDisassembleFn;
  /** VA to disassemble first when using a file source. */
  initialAddress?: bigint;
  /** Reformat an unsymbolized instruction address (VA) — PE viewer address mode. */
  addressFormatter?: (va: bigint) => string;
  /** Reinterpret a goto-box address before navigating (PE viewer: map an
   * RVA/file-offset typed per the address mode to the VA this view needs). */
  translateGotoInput?: (address: bigint) => bigint;
  /** Unified back/forward history for this view's dock scope. */
  navHistory: NavHistoryStore;
}

export function AssemblyView({ sessionId, isPaused, canLoad, address, registers, resolveSymbol, breakpointAddresses, emulation, onToggleBreakpoint, onSetHardwareBreakpoint, onAssemblePatch, onAddBookmark, symbolsRefreshKey, onNavigateToSource, disassemble, initialAddress, addressFormatter, translateGotoInput, navHistory }: AssemblyViewProps) {
  const [addressInput, setAddressInput] = useState("");
  // Inline assembly input state
  const [assembleTarget, setAssembleTarget] = useState<{ address: string; defaultText: string } | null>(null);
  const [assembleError, setAssembleError] = useState<string | null>(null);
  const [nopPad, setNopPad] = useState(() => {
    try { return localStorage.getItem(NOP_PAD_KEY) !== "false"; } catch { return true; }
  });
  const assembleInputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const virtualizerRef = useRef<Virtualizer<HTMLDivElement, Element>>(null);
  // Track which line is selected (for keyboard breakpoint toggle)
  const [selectedAddress, setSelectedAddress] = useState<string | null>(null);
  // Track which address is being highlighted (for fade animation)
  const [highlightedAddress, setHighlightedAddress] = useState<bigint | null>(null);
  // Track which jump target is being hovered (for live highlight)
  const [hoveredJumpTarget, setHoveredJumpTarget] = useState<bigint | null>(null);
  // Resizable column widths
  const { columnWidths, handleColumnResizeStart } = useColumnWidths<keyof ColumnWidths>(COLUMN_WIDTHS_KEY, DEFAULT_COLUMN_WIDTHS);
  // Context menu for right-click
  const { contextMenu, openContextMenu, closeContextMenu } = useContextMenu<{ address: string; mnemonic: string; op_str: string }>();
  // Addresses executed by the quick emulator (session hosts only).
  const executedAddresses = emulation?.executedAddresses ?? null;

  const {
    instructions,
    pcAddress,
    isLoading,
    error,
    showBytes,
    canGoBack,
    canGoForward,
    jumpTargetAddress,
    loadGeneration,
    prependSignal,
    goToAddressDirect,
    followJump,
    refresh,
    toggleBytesColumn,
    goToPC,
    loadMoreAbove,
    loadMoreBelow,
  } = useAssemblyView({
    sessionId,
    isPaused,
    canLoad,
    pcAddress: address,
    registers,
    resolveSymbol,
    symbolsRefreshKey,
    disassemble,
    initialAddress,
    navHistory,
  });

  const handleJumpTargetClick = useCallback((jumpTarget: string, sourceAddress: string) => {
    try {
      followJump(BigInt(jumpTarget), BigInt(sourceAddress));
    } catch {
      console.error("Invalid jump target:", jumpTarget);
    }
  }, [followJump]);

  const handleNavigateToEmulationAddress = useCallback((addr: string) => {
    goToAddressDirect(BigInt(addr));
  }, [goToAddressDirect]);

  // Stable row handlers so the memoized InstructionRow can bail out of
  // unrelated parent re-renders (emulation results, hover state, scrolling).
  const handleRowClick = useCallback((addr: string) => {
    setSelectedAddress(addr.toUpperCase());
    // Passive source sync: if the Source tab is mounted it scrolls
    // to the matching line; it does not steal the active tab.
    sourceNavigation.request(addr);
  }, []);

  const handleRowContextMenu = useCallback((e: React.MouseEvent, addr: string, mnemonic: string, opStr: string) => {
    openContextMenu(e, { address: addr, mnemonic, op_str: opStr });
  }, [openContextMenu]);

  // Handle hover on jump target link
  const handleJumpTargetHover = useCallback((jumpTarget: string | null) => {
    if (jumpTarget === null) {
      setHoveredJumpTarget(null);
    } else {
      try {
        setHoveredJumpTarget(BigInt(jumpTarget));
      } catch {
        setHoveredJumpTarget(null);
      }
    }
  }, []);

  // Latest rows for the auto-scroll effects, WITHOUT them depending on
  // `instructions` — a scroll extension (prepend/append) grows that array but
  // must NOT re-fire PC-follow/jump scrolling; those effects gate on
  // `loadGeneration` (bumped only on a full replace) instead. Synced in a layout
  // effect so every passive effect sees the fresh rows regardless of
  // declaration order.
  const instructionsForScrollRef = useRef(instructions);
  useLayoutEffect(() => { instructionsForScrollRef.current = instructions; }, [instructions]);

  const scrollToInstruction = useCallback((addr: bigint) => {
    const key = `0X${addr.toString(16).toUpperCase()}`;
    const index = instructionsForScrollRef.current.findIndex((i) => i.address.toUpperCase() === key);
    if (index >= 0) {
      virtualizerRef.current?.scrollToIndex(index, { align: 'center' });
    }
  }, []);

  // Go-to-PC button: hand control back to PC-follow, then re-center the PC row
  // if it's already loaded (a reload re-centers via the PC scroll effect).
  const handleGoToPC = useCallback(() => {
    goToPC();
    if (pcAddress !== null) scrollToInstruction(pcAddress);
  }, [goToPC, pcAddress, scrollToInstruction]);

  // Scroll to PC on a fresh load / PC change (never on a scroll extension).
  // Only if there's no jump target (user navigation takes priority).
  useEffect(() => {
    if (jumpTargetAddress === null && pcAddress !== null) {
      scrollToInstruction(pcAddress);
    }
  }, [pcAddress, jumpTargetAddress, loadGeneration, scrollToInstruction]);

  // Scroll to and highlight jump target when navigating (fresh load or in-view jump).
  useEffect(() => {
    if (jumpTargetAddress !== null) {
      scrollToInstruction(jumpTargetAddress);
      setHighlightedAddress(jumpTargetAddress);
      const timer = setTimeout(() => {
        setHighlightedAddress(null);
      }, 1000);
      return () => clearTimeout(timer);
    }
  }, [jumpTargetAddress, loadGeneration, scrollToInstruction]);

  // Edge extension and prepend handling key off user intent. A full replace
  // moves scrollTop synthetically — the browser clamps it when content shrinks
  // (big function → small one on step-in) and the PC/jump centering calls
  // scrollToIndex — and those scroll events must not auto-extend the fresh
  // view. Latch on a real gesture (wheel, pointer down for scrollbar drags);
  // reset on every full replace, synchronously so the clamp event can't sneak
  // in first.
  const userGestureSinceLoadRef = useRef(false);
  useLayoutEffect(() => { userGestureSinceLoadRef.current = false; }, [loadGeneration]);

  // After a prepend, content grew by `count` rows above the viewport. Bump the
  // scroll element's offset by the same amount, synchronously (pre-paint), so the
  // rows the user was looking at stay put — no visible jump. Direct scrollTop
  // adjustment sidesteps the virtualizer's pending-scroll logic.
  // A prepend BEFORE any user gesture is the load's context prefetch — there,
  // re-center the navigation anchor (jump target or PC) instead, so the
  // freshly loaded context surrounds it rather than pushing it off-center.
  const handledPrependRef = useRef(prependSignal);
  useLayoutEffect(() => {
    if (prependSignal === handledPrependRef.current) return;
    handledPrependRef.current = prependSignal;
    const el = virtualizerRef.current?.scrollElement;
    if (el) el.scrollTop += prependSignal.count * ASSEMBLY_ROW_HEIGHT;
    if (!userGestureSinceLoadRef.current) {
      const anchor = jumpTargetAddress ?? pcAddress;
      if (anchor !== null) scrollToInstruction(anchor);
    }
  }, [prependSignal, jumpTargetAddress, pcAddress, scrollToInstruction]);

  // Shared edge check for the scroll and wheel handlers. `only` restricts the
  // check to one edge (the wheel direction), so an up-wheel on content that fits
  // the viewport doesn't also pull in rows below. The hook's single-in-flight +
  // end-of-range guards keep this from spamming requests, and the prepend
  // scroll-compensation moves the viewport off the top edge so it won't
  // immediately re-trigger.
  const maybeExtendAtEdges = useCallback((el: HTMLElement, only?: 'above' | 'below') => {
    const threshold = ASSEMBLY_ROW_HEIGHT * 8;
    if (only !== 'below' && el.scrollTop <= threshold) loadMoreAbove();
    if (only !== 'above' && el.scrollHeight - (el.scrollTop + el.clientHeight) <= threshold) loadMoreBelow();
  }, [loadMoreAbove, loadMoreBelow]);

  // Extend the loaded range as the user scrolls to either edge.
  const handleViewportScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    if (!userGestureSinceLoadRef.current) return;
    maybeExtendAtEdges(e.currentTarget);
  }, [maybeExtendAtEdges]);

  // Wheel-driven extension. The scroll handler above only fires when the content
  // overflows the viewport; when the whole loaded range fits (e.g. a short function,
  // or the user landed at `func+9` with nothing above), there's no scrollbar and
  // wheeling produces no scroll event. A native wheel listener still fires, so an
  // up-wheel at the top / down-wheel at the bottom pulls in more — this is what
  // makes scroll-up work at all when there's nothing yet above the anchor.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const markGesture = () => { userGestureSinceLoadRef.current = true; };
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY === 0) return;
      markGesture();
      const sc = virtualizerRef.current?.scrollElement;
      if (sc) maybeExtendAtEdges(sc, e.deltaY < 0 ? 'above' : 'below');
    };
    el.addEventListener('wheel', onWheel, { passive: true });
    el.addEventListener('pointerdown', markGesture);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('pointerdown', markGesture);
    };
  }, [maybeExtendAtEdges]);

  // Keyboard shortcuts — chord-based lookup via keybinding context
  const { reverseLookup, getKeybinding } = useKeybindingContext();

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const chord = keyboardEventToChord(e);
      if (!chord) return;

      const action = reverseLookup.get(chord);
      // Back/forward chords are handled here only in file mode (PE reader). In
      // session mode SessionDocked owns them, so back works even when this
      // view's tab is closed — handling both would double-navigate.
      if (action === "assembly.goBack" && disassemble) {
        e.preventDefault();
        navHistory.goBack();
      } else if (action === "assembly.goForward" && disassemble) {
        e.preventDefault();
        navHistory.goForward();
      } else if (action === "assembly.toggleBreakpoint") {
        e.preventDefault();
        const addr = selectedAddress ?? (pcAddress !== null ? `0X${pcAddress.toString(16).toUpperCase()}` : null);
        if (addr && onToggleBreakpoint) onToggleBreakpoint(addr);
      } else if (chord === " " && selectedAddress && onAssemblePatch && !assembleTarget) {
        e.preventDefault();
        const inst = instructions.find(i => i.address.toUpperCase() === selectedAddress);
        const defaultText = inst ? `${inst.mnemonic} ${inst.op_str}`.trim() : "";
        setAssembleTarget({ address: selectedAddress, defaultText });
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [navHistory, disassemble, reverseLookup, selectedAddress, pcAddress, onToggleBreakpoint, onAssemblePatch, assembleTarget, instructions]);

  // Determine content to show. A "no active process" / "must be paused" condition
  // isn't a real error — treat it as the neutral empty state ("No disassembly
  // available") rather than a red error box (e.g. in non-invasive Open sessions
  // before an address is chosen).
  const benignUnavailable = error !== null && isBenignSessionError(error);
  const showEmptyState = (!sessionId && !disassemble) || benignUnavailable || (address == null && !disassemble && instructions.length === 0 && !error && !isLoading);
  const showErrorState = error !== null && !benignUnavailable;
  const showLoadingState = isLoading && instructions.length === 0 && !error;
  const showInstructions = instructions.length > 0;

  return (
    <DockPanel ref={containerRef} data-testid="assembly-panel">
      {/* Toolbar */}
      <PanelToolbar>
        {/* Go-to address input */}
        <AddressExpressionInput
          value={addressInput}
          onChange={setAddressInput}
          onResolve={(addr) => goToAddressDirect(translateGotoInput ? translateGotoInput(addr) : addr)}
          registers={registers}
          resolveSymbol={resolveSymbol}
          sessionId={sessionId}
          inputClassName="w-48"
        />

        {/* Navigation back/forward */}
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon-xs"
            onClick={() => navHistory.goBack()}
            disabled={!canGoBack}
            title={`Go back (${getKeybinding("assembly.goBack")})`}
          >
            <ArrowLeft />
          </Button>
          <Button
            variant="outline"
            size="icon-xs"
            onClick={() => navHistory.goForward()}
            disabled={!canGoForward}
            title={`Go forward (${getKeybinding("assembly.goForward")})`}
          >
            <ArrowRight />
          </Button>
        </div>

        {/* Go to current PC (session mode only — file mode has no PC) */}
        {!disassemble && (
          <Button
            variant="outline"
            size="icon-xs"
            onClick={handleGoToPC}
            disabled={pcAddress === null}
            title="Go to PC (RIP)"
          >
            <LocateFixed />
          </Button>
        )}

        {/* Refresh */}
        <Button
          variant="outline"
          size="icon-xs"
          onClick={refresh}
          disabled={isLoading}
          title="Refresh"
        >
          <RefreshCw className={cn(isLoading && "animate-spin")} />
        </Button>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Bytes column toggle */}
        <div className="flex items-center gap-2">
          <Label htmlFor="show-bytes" className="text-xs">Bytes</Label>
          <Switch
            id="show-bytes"
            size="xs"
            checked={showBytes}
            onCheckedChange={toggleBytesColumn}
          />
        </div>
      </PanelToolbar>

      {/* Inline assembly input */}
      {assembleTarget && (
        <div className="shrink-0 border-b border-border bg-muted/40">
          <div className="flex items-center gap-2 px-2 py-1.5">
            <span className="text-xs font-mono text-muted-foreground shrink-0">
              Assemble @ {assembleTarget.address}:
            </span>
            <Input
              ref={assembleInputRef}
              defaultValue={assembleTarget.defaultText}
              placeholder="e.g. nop, mov eax, 1"
              inputSize="xs"
              className={cn("flex-1 font-mono", assembleError && "border-red-500 focus-visible:ring-red-500")}
              onChange={() => { if (assembleError) setAssembleError(null); }}
              onKeyDown={async (e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  const text = (e.target as HTMLInputElement).value.trim();
                  if (text && onAssemblePatch) {
                    const err = await onAssemblePatch(assembleTarget.address, text, nopPad);
                    if (err) {
                      setAssembleError(err);
                      return;
                    }
                  }
                  setAssembleError(null);
                  setAssembleTarget(null);
                } else if (e.key === "Escape") {
                  setAssembleError(null);
                  setAssembleTarget(null);
                }
              }}
              autoFocus
            />
            <div className="flex items-center gap-1.5 shrink-0">
              <Label htmlFor="nop-pad" className="text-xs whitespace-nowrap">NOPs</Label>
              <Switch
                id="nop-pad"
                size="xs"
                checked={nopPad}
                onCheckedChange={(checked) => {
                  setNopPad(checked);
                  try { localStorage.setItem(NOP_PAD_KEY, String(checked)); } catch {}
                }}
              />
            </div>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => { setAssembleError(null); setAssembleTarget(null); }}
            >
              Cancel
            </Button>
          </div>
          {assembleError && (
            <div className="px-2 pb-1.5 text-xs text-red-500 font-mono truncate" title={assembleError}>
              {assembleError}
            </div>
          )}
        </div>
      )}

      {/* Column header - fixed outside scroll area */}
      {showInstructions && (
        <div className="shrink-0 flex items-center px-2 py-0.5 border-b border-border font-mono text-xs text-foreground/60 select-none">
          <span className="w-4 shrink-0" />
          <span className="w-4 shrink-0" />
          <span className="shrink-0 truncate" style={{ width: columnWidths.symbol }}>Symbol</span>
          <div className="w-1 shrink-0 self-stretch cursor-col-resize hover:bg-blue-500/30 active:bg-blue-500/50 mx-px" onMouseDown={(e) => handleColumnResizeStart("symbol", e)} />
          {showBytes && (
            <>
              <span className="shrink-0 truncate" style={{ width: columnWidths.bytes }}>Bytes</span>
              <div className="w-1 shrink-0 self-stretch cursor-col-resize hover:bg-blue-500/30 active:bg-blue-500/50 mx-px" onMouseDown={(e) => handleColumnResizeStart("bytes", e)} />
            </>
          )}
          <span className="shrink-0 truncate" style={{ width: columnWidths.mnemonic }}>Mnemonic</span>
          <div className="w-1 shrink-0 self-stretch cursor-col-resize hover:bg-blue-500/30 active:bg-blue-500/50 mx-px" onMouseDown={(e) => handleColumnResizeStart("mnemonic", e)} />
          <span className="flex-1">Operands</span>
        </div>
      )}

      {/* Main content area */}
      {showInstructions ? (
        <VirtualizedList
          items={instructions}
          rowHeight={ASSEMBLY_ROW_HEIGHT}
          overscan={30}
          className="flex-1 min-h-0"
          virtualizerRef={virtualizerRef}
          onViewportScroll={handleViewportScroll}
          renderItem={(inst) => {
            const instAddrUpper = inst.address.toUpperCase();
            const isPC = pcAddress !== null && instAddrUpper === `0X${pcAddress.toString(16).toUpperCase()}`;
            const isHighlighted = highlightedAddress !== null && instAddrUpper === `0X${highlightedAddress.toString(16).toUpperCase()}`;
            const isHoverTarget = hoveredJumpTarget !== null && instAddrUpper === `0X${hoveredJumpTarget.toString(16).toUpperCase()}`;
            const hasBreakpoint = breakpointAddresses?.has(instAddrUpper) ?? false;
            const isExecuted = executedAddresses?.has(instAddrUpper) ?? false;

            return (
              <InstructionRow
                instruction={inst}
                isPC={isPC}
                isExecuted={isExecuted}
                isSelected={selectedAddress === instAddrUpper}
                isHighlighted={isHighlighted}
                isHoverTarget={isHoverTarget}
                hasBreakpoint={hasBreakpoint}
                isPatched={inst.is_patched ?? false}
                showBytes={showBytes}
                columnWidths={columnWidths}
                addressFormatter={addressFormatter}
                onClick={handleRowClick}
                onJumpTargetClick={handleJumpTargetClick}
                onJumpTargetHover={handleJumpTargetHover}
                onContextMenu={handleRowContextMenu}
              />
            );
          }}
        />
      ) : (
        <PanelBody>
          {showEmptyState && (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
              <div className="text-center">
                <Cpu className="h-12 w-12 mx-auto mb-4 opacity-50" />
                <p className="text-base font-medium">No disassembly available</p>
                <p className="text-sm mt-1">Enter an address or symbol above to disassemble</p>
              </div>
            </div>
          )}
          {showErrorState && (
            <div className="flex items-center justify-center h-full text-red-500 p-4">
              <div className="text-center">
                <p>Error loading disassembly:</p>
                <p className="text-sm mt-1 font-mono">{error}</p>
              </div>
            </div>
          )}
          {showLoadingState && (
            <div className="flex items-center justify-center h-full text-muted-foreground p-4">
              <div className="text-center">
                <Cpu className="h-8 w-8 mx-auto mb-2 animate-pulse" />
                <p>Loading disassembly...</p>
              </div>
            </div>
          )}
        </PanelBody>
      )}

      {/* Quick Emulation footer — session hosts pass `emulation`; the PE viewer doesn't */}
      {emulation && <EmulationQuickView emulation={emulation} onNavigateToAddress={handleNavigateToEmulationAddress} />}

      {/* Context Menu */}
      {contextMenu && (
        <ContextMenu x={contextMenu.x} y={contextMenu.y} onClose={closeContextMenu} className="min-w-[180px]">
          {onToggleBreakpoint && (
            <ContextMenuItem
              icon={<Circle className="text-red-500" />}
              onClick={() => onToggleBreakpoint(contextMenu.data.address)}
            >
              {breakpointAddresses?.has(contextMenu.data.address.toUpperCase()) ? "Remove Breakpoint" : "Toggle Breakpoint"}
            </ContextMenuItem>
          )}
          {onSetHardwareBreakpoint && (
            <ContextMenuItem
              icon={<CircleDot className="text-orange-500" />}
              onClick={() => onSetHardwareBreakpoint(contextMenu.data.address, "Execute", 1)}
            >
              Add Hardware Breakpoint
            </ContextMenuItem>
          )}
          {onAssemblePatch && (
            <ContextMenuItem
              icon={<Wrench className="text-purple-500" />}
              onClick={() => {
                const defaultText = `${contextMenu.data.mnemonic} ${contextMenu.data.op_str}`.trim();
                setAssembleTarget({ address: contextMenu.data.address, defaultText });
              }}
            >
              Assemble...
            </ContextMenuItem>
          )}
          {onAddBookmark && (
            <ContextMenuItem
              icon={<Bookmark className="text-blue-400" />}
              onClick={() => {
                const asm = `${contextMenu.data.mnemonic} ${contextMenu.data.op_str}`.trim();
                onAddBookmark(contextMenu.data.address, asm);
              }}
            >
              Add to Bookmarks
            </ContextMenuItem>
          )}
          {onNavigateToSource && (
            <ContextMenuItem
              icon={<FileCode className="text-blue-400" />}
              onClick={() => onNavigateToSource(contextMenu.data.address)}
            >
              Show Source
            </ContextMenuItem>
          )}
          <ContextMenuItem
            icon={<Copy className="text-muted-foreground" />}
            onClick={async () => {
              await navigator.clipboard.writeText(contextMenu.data.address);
            }}
          >
            Copy Address
          </ContextMenuItem>
        </ContextMenu>
      )}
    </DockPanel>
  );
}

// Instruction row component
interface InstructionRowProps {
  instruction: Instruction;
  isPC: boolean;
  isExecuted: boolean;
  isSelected: boolean;
  isHighlighted: boolean;
  isHoverTarget: boolean;
  hasBreakpoint: boolean;
  isPatched: boolean;
  showBytes: boolean;
  columnWidths: ColumnWidths;
  onClick: (address: string) => void;
  onJumpTargetClick: (target: string, sourceAddress: string) => void;
  onJumpTargetHover: (target: string | null) => void;
  onContextMenu: (e: React.MouseEvent, address: string, mnemonic: string, opStr: string) => void;
  addressFormatter?: (va: bigint) => string;
}

// Row background per highlight state. Precedence is the order of the ladder in
// InstructionRow — a new state slots in as one line there plus one entry here.
type RowHighlight = "selected" | "hover-target" | "pc" | "patched" | "executed";
const ROW_HIGHLIGHT_BG: Record<RowHighlight, string> = {
  selected: "bg-accent/50",
  "hover-target": "bg-blue-100 dark:bg-blue-900/40",
  pc: "bg-yellow-100 dark:bg-yellow-900/40",
  patched: "bg-purple-100 dark:bg-purple-900/30",
  executed: "bg-green-100 dark:bg-green-900/30",
};

const InstructionRow = memo(function InstructionRow({ instruction, isPC, isExecuted, isSelected, isHighlighted, isHoverTarget, hasBreakpoint, isPatched, showBytes, columnWidths, onClick, onJumpTargetClick, onJumpTargetHover, onContextMenu, addressFormatter }: InstructionRowProps) {
  // Unsymbolized instructions fall back to the address, reformatted per the
  // PE viewer's address mode (VA/RVA/file). Symbolized labels are mode-neutral.
  const symbolText =
    instruction.symbol ??
    (addressFormatter ? addressFormatter(BigInt(instruction.address)) : instruction.address);
  const { mnemonic, op_str, is_jump, is_call, is_ret, jump_target } = instruction;

  // Render operands with clickable jump target
  const renderOperands = () => {
    if (jump_target && (is_jump || is_call)) {
      return (
        <span
          className="text-blue-400 cursor-pointer hover:underline hover:text-blue-300"
          onClick={() => onJumpTargetClick(jump_target, instruction.address)}
          onMouseEnter={() => onJumpTargetHover(jump_target)}
          onMouseLeave={() => onJumpTargetHover(null)}
          title={`Jump to ${jump_target}`}
        >
          {op_str}
        </span>
      );
    }
    return <span>{op_str}</span>;
  };

  // First match wins; data-highlight exposes the winner so e2e tests assert
  // state instead of Tailwind classes.
  const highlight: RowHighlight | undefined =
    isSelected ? "selected"
    : isHoverTarget ? "hover-target"
    : isPC ? "pc"
    : isPatched ? "patched"
    : isExecuted ? "executed"
    : undefined;

  return (
    <div
      data-testid="asm-row"
      data-highlight={highlight}
      className={cn(
        "flex items-center hover:bg-muted/30 px-2 cursor-default",
        highlight && ROW_HIGHLIGHT_BG[highlight],
        isHighlighted && "animate-highlight-fade"
      )}
      style={{ height: ASSEMBLY_ROW_HEIGHT }}
      onClick={() => onClick(instruction.address)}
      onContextMenu={(e) => onContextMenu(e, instruction.address, instruction.mnemonic, instruction.op_str)}
    >
      {/* PC indicator */}
      <span className="w-4 shrink-0 text-yellow-600 dark:text-yellow-400">
        {isPC && <ChevronRight className="h-3 w-3" />}
      </span>

      {/* Breakpoint indicator */}
      <span className="w-4 shrink-0 flex items-center justify-center">
        {hasBreakpoint && <Circle className="h-2.5 w-2.5 fill-red-500 text-red-500" />}
      </span>

      {/* Address/Symbol column — mr-1.5 mirrors the header's 6px resize
          handle so columns align and truncated text never touches the next
          column */}
      <span className="shrink-0 mr-1.5 text-muted-foreground flex" style={{ width: columnWidths.symbol }}>
        <TruncatedSymbol text={symbolText} className="flex-1" />
      </span>

      {/* Bytes column (conditional) */}
      {showBytes && (
        <span className="shrink-0 mr-1.5 text-gray-500 truncate" style={{ width: columnWidths.bytes }} title={instruction.bytes}>
          {instruction.bytes}
        </span>
      )}

      {/* Mnemonic - color coded */}
      <span
        className={cn(
          "shrink-0 mr-1.5",
          is_call && "text-green-500",
          is_jump && !is_call && "text-blue-500",
          is_ret && "text-red-500",
          !is_call && !is_jump && !is_ret && "text-blue-400"
        )}
        style={{ width: columnWidths.mnemonic }}
      >
        {mnemonic}
      </span>

      {/* Operands */}
      <span className="flex-1 truncate">
        {renderOperands()}
      </span>
    </div>
  );
});
