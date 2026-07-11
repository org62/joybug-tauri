import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { VirtualizedList } from "./ui/virtualized-list";
import { DockPanel, PanelToolbar, PanelBody } from "@/components/ui/panel";
import { ContextMenu, ContextMenuItem } from "@/components/ui/context-menu";
import { TruncatedSymbol } from "@/components/ui/truncated-symbol";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Switch } from "./ui/switch";
import { Label } from "./ui/label";
import { Cpu, ArrowLeft, ArrowRight, RefreshCw, ChevronRight, Circle, CircleDot, Wrench, Copy, Bookmark, FileCode } from "lucide-react";
import { sourceNavigation } from "@/lib/navigationStore";
import { cn } from "@/lib/utils";
import { useAssemblyView, Instruction } from "@/hooks/useAssemblyView";
import { RegisterContext, SymbolResolver, sanitizeAddressInput } from "@/lib/hexUtils";
import { isBenignSessionError } from "@/lib/sessionHelpers";
import { useContextMenu } from "@/hooks/useContextMenu";
import { useColumnWidths } from "@/hooks/useColumnWidths";
import { EmulationQuickView } from "./EmulationQuickView";
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
  address?: number;
  registers?: RegisterContext;
  resolveSymbol?: SymbolResolver;
  breakpointAddresses?: Set<string>;
  onToggleBreakpoint?: (address: string) => void;
  onSetHardwareBreakpoint?: (address: string, hwType: string, hwSize: number) => void;
  onAssemblePatch?: (address: string, assemblyText: string, nopPad?: boolean) => Promise<string | null>;
  onAddBookmark?: (address: string, asmText: string) => void;
  symbolsRefreshKey?: string;
  /** Activate the Source tab and reveal an address's source line (context-menu action). */
  onNavigateToSource?: (address: string) => void;
}

export function AssemblyView({ sessionId, isPaused, address, registers, resolveSymbol, breakpointAddresses, onToggleBreakpoint, onSetHardwareBreakpoint, onAssemblePatch, onAddBookmark, symbolsRefreshKey, onNavigateToSource }: AssemblyViewProps) {
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

  const {
    instructions,
    pcAddress,
    isLoading,
    error,
    showBytes,
    canGoBack,
    canGoForward,
    jumpTargetAddress,
    goToAddress,
    goToAddressDirect,
    scrollToAddressInView,
    goBack,
    goForward,
    refresh,
    toggleBytesColumn,
  } = useAssemblyView({
    sessionId,
    isPaused,
    pcAddress: address,
    registers,
    resolveSymbol,
    symbolsRefreshKey,
  });

  // Handle go-to action
  const handleGoTo = useCallback(async () => {
    if (addressInput.trim()) {
      await goToAddress(addressInput);
    }
  }, [addressInput, goToAddress]);

  // Handle jump target click
  const handleJumpTargetClick = useCallback((jumpTarget: string) => {
    try {
      const addr = BigInt(jumpTarget);
      const addrUpper = `0X${addr.toString(16).toUpperCase()}`;

      // Check if target is already in current instructions (same view)
      const isInView = instructions.some(inst => inst.address.toUpperCase() === addrUpper);

      if (isInView) {
        // Just scroll to it, no history entry needed
        scrollToAddressInView(addr);
      } else {
        // Navigate to new function/location
        goToAddressDirect(addr);
      }
    } catch (e) {
      console.error("Invalid jump target:", jumpTarget);
    }
  }, [instructions, scrollToAddressInView, goToAddressDirect]);

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

  // Build address-to-index lookup for virtualizer scrolling
  const addressIndexMap = useMemo(() => {
    const map = new Map<string, number>();
    for (let i = 0; i < instructions.length; i++) {
      map.set(instructions[i].address.toUpperCase(), i);
    }
    return map;
  }, [instructions]);

  // Scroll to PC when pcAddress changes or when instructions load
  // But only if there's no jump target (user navigation takes priority)
  useEffect(() => {
    if (jumpTargetAddress === null && pcAddress !== null && instructions.length > 0) {
      const pcKey = `0X${pcAddress.toString(16).toUpperCase()}`;
      const index = addressIndexMap.get(pcKey);
      if (index !== undefined) {
        virtualizerRef.current?.scrollToIndex(index, { align: 'center' });
      }
    }
  }, [pcAddress, instructions, jumpTargetAddress, addressIndexMap]);

  // Scroll to and highlight jump target when navigating
  useEffect(() => {
    if (jumpTargetAddress !== null && instructions.length > 0) {
      const targetKey = `0X${jumpTargetAddress.toString(16).toUpperCase()}`;
      const index = addressIndexMap.get(targetKey);
      if (index !== undefined) {
        virtualizerRef.current?.scrollToIndex(index, { align: 'center' });
      }
      setHighlightedAddress(jumpTargetAddress);
      const timer = setTimeout(() => {
        setHighlightedAddress(null);
      }, 1000);
      return () => clearTimeout(timer);
    }
  }, [jumpTargetAddress, instructions, addressIndexMap]);

  // Keyboard shortcuts — chord-based lookup via keybinding context
  const { reverseLookup, getKeybinding } = useKeybindingContext();

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const chord = keyboardEventToChord(e);
      if (!chord) return;

      const action = reverseLookup.get(chord);
      if (action === "assembly.goBack") {
        e.preventDefault();
        goBack();
      } else if (action === "assembly.goForward") {
        e.preventDefault();
        goForward();
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
  }, [goBack, goForward, reverseLookup, selectedAddress, pcAddress, onToggleBreakpoint, onAssemblePatch, assembleTarget, instructions]);

  // Mouse back/forward button navigation (buttons 3 & 4)
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleMouseDown = (e: MouseEvent) => {
      if (e.button === 3) {
        e.preventDefault();
        e.stopPropagation();
        goBack();
      } else if (e.button === 4) {
        e.preventDefault();
        e.stopPropagation();
        goForward();
      }
    };

    container.addEventListener("mousedown", handleMouseDown);
    return () => container.removeEventListener("mousedown", handleMouseDown);
  }, [goBack, goForward]);

  // Determine content to show. A "no active process" / "must be paused" condition
  // isn't a real error — treat it as the neutral empty state ("No disassembly
  // available") rather than a red error box (e.g. in non-invasive Open sessions
  // before an address is chosen).
  const benignUnavailable = error !== null && isBenignSessionError(error);
  const showEmptyState = !sessionId || benignUnavailable || (address == null && instructions.length === 0 && !error && !isLoading);
  const showErrorState = error !== null && !benignUnavailable;
  const showLoadingState = isLoading && instructions.length === 0 && !error;
  const showInstructions = instructions.length > 0;

  return (
    <DockPanel ref={containerRef} data-capture-mouse-nav>
      {/* Toolbar */}
      <PanelToolbar>
        {/* Go-to address input */}
        <div className="flex items-center gap-1">
          <Input
            placeholder="rip, symbol, rax+0x10..."
            value={addressInput}
            onChange={(e) => setAddressInput(sanitizeAddressInput(e.target.value))}
            onKeyDown={(e) => e.key === "Enter" && handleGoTo()}
            inputSize="xs"
            className="w-48 font-mono"
          />
          <Button variant="outline" size="xs" onClick={handleGoTo}>
            Go
          </Button>
        </div>

        {/* Navigation back/forward */}
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon-xs"
            onClick={goBack}
            disabled={!canGoBack}
            title={`Go back (${getKeybinding("assembly.goBack")})`}
          >
            <ArrowLeft />
          </Button>
          <Button
            variant="outline"
            size="icon-xs"
            onClick={goForward}
            disabled={!canGoForward}
            title={`Go forward (${getKeybinding("assembly.goForward")})`}
          >
            <ArrowRight />
          </Button>
        </div>

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
          renderItem={(inst) => {
            const instAddrUpper = inst.address.toUpperCase();
            const isPC = pcAddress !== null && instAddrUpper === `0X${pcAddress.toString(16).toUpperCase()}`;
            const isHighlighted = highlightedAddress !== null && instAddrUpper === `0X${highlightedAddress.toString(16).toUpperCase()}`;
            const isHoverTarget = hoveredJumpTarget !== null && instAddrUpper === `0X${hoveredJumpTarget.toString(16).toUpperCase()}`;
            const hasBreakpoint = breakpointAddresses?.has(instAddrUpper) ?? false;

            return (
              <InstructionRow
                instruction={inst}
                isPC={isPC}
                isSelected={selectedAddress === instAddrUpper}
                isHighlighted={isHighlighted}
                isHoverTarget={isHoverTarget}
                hasBreakpoint={hasBreakpoint}
                isPatched={inst.is_patched ?? false}
                showBytes={showBytes}
                columnWidths={columnWidths}
                onClick={(addr) => {
                  setSelectedAddress(addr.toUpperCase());
                  // Passive source sync: if the Source tab is mounted it scrolls
                  // to the matching line; it does not steal the active tab.
                  sourceNavigation.request(addr);
                }}
                onJumpTargetClick={handleJumpTargetClick}
                onJumpTargetHover={handleJumpTargetHover}
                onContextMenu={(e, addr, mnemonic, opStr) => openContextMenu(e, { address: addr, mnemonic, op_str: opStr })}
                style={{ height: ASSEMBLY_ROW_HEIGHT }}
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

      {/* Quick Emulation footer */}
      <EmulationQuickView sessionId={sessionId} isPaused={isPaused} pcAddress={address} onNavigateToAddress={(addr) => goToAddressDirect(BigInt(addr))} />

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
  isSelected: boolean;
  isHighlighted: boolean;
  isHoverTarget: boolean;
  hasBreakpoint: boolean;
  isPatched: boolean;
  showBytes: boolean;
  columnWidths: ColumnWidths;
  onClick: (address: string) => void;
  onJumpTargetClick: (target: string) => void;
  onJumpTargetHover: (target: string | null) => void;
  onContextMenu: (e: React.MouseEvent, address: string, mnemonic: string, opStr: string) => void;
  style?: React.CSSProperties;
}

function InstructionRow({ instruction, isPC, isSelected, isHighlighted, isHoverTarget, hasBreakpoint, isPatched, showBytes, columnWidths, onClick, onJumpTargetClick, onJumpTargetHover, onContextMenu, style }: InstructionRowProps) {
  const { mnemonic, op_str, is_jump, is_call, is_ret, jump_target } = instruction;

  // Render operands with clickable jump target
  const renderOperands = () => {
    if (jump_target && (is_jump || is_call)) {
      return (
        <span
          className="text-blue-400 cursor-pointer hover:underline hover:text-blue-300"
          onClick={() => onJumpTargetClick(jump_target)}
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

  return (
    <div
      className={cn(
        "flex items-center hover:bg-muted/30 px-2 cursor-default",
        isSelected && "bg-accent/50",
        isPC && !isSelected && "bg-yellow-100 dark:bg-yellow-900/40",
        isPatched && !isPC && !isSelected && "bg-purple-100 dark:bg-purple-900/30",
        isHighlighted && "animate-highlight-fade",
        isHoverTarget && !isSelected && "bg-blue-100 dark:bg-blue-900/40"
      )}
      style={style}
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
        <TruncatedSymbol text={instruction.symbol} className="flex-1" />
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
}
