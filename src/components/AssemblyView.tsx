import { useState, useRef, useEffect, useCallback } from "react";
import { ScrollArea } from "./ui/scroll-area";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Switch } from "./ui/switch";
import { Label } from "./ui/label";
import { Cpu, ArrowLeft, ArrowRight, RefreshCw, ChevronRight, Circle } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAssemblyView, Instruction } from "@/hooks/useAssemblyView";
import { RegisterContext, SymbolResolver, sanitizeAddressInput } from "@/lib/hexUtils";
import { useContextMenu } from "@/hooks/useContextMenu";
import { EmulationQuickView } from "./EmulationQuickView";

const COLUMN_WIDTHS_KEY = "assembly-column-widths";
const MIN_COL_WIDTH = 40;

interface ColumnWidths {
  symbol: number;
  bytes: number;
  mnemonic: number;
}

const DEFAULT_COLUMN_WIDTHS: ColumnWidths = { symbol: 320, bytes: 144, mnemonic: 64 };

function getInitialColumnWidths(): ColumnWidths {
  try {
    const stored = localStorage.getItem(COLUMN_WIDTHS_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      return {
        symbol: Math.max(MIN_COL_WIDTH, parsed.symbol ?? DEFAULT_COLUMN_WIDTHS.symbol),
        bytes: Math.max(MIN_COL_WIDTH, parsed.bytes ?? DEFAULT_COLUMN_WIDTHS.bytes),
        mnemonic: Math.max(MIN_COL_WIDTH, parsed.mnemonic ?? DEFAULT_COLUMN_WIDTHS.mnemonic),
      };
    }
  } catch {}
  return { ...DEFAULT_COLUMN_WIDTHS };
}

interface AssemblyViewProps {
  sessionId?: string;
  isPaused?: boolean;
  address?: number;
  registers?: RegisterContext;
  resolveSymbol?: SymbolResolver;
  breakpointAddresses?: Set<string>;
  onToggleBreakpoint?: (address: string) => void;
}

export function AssemblyView({ sessionId, isPaused, address, registers, resolveSymbol, breakpointAddresses, onToggleBreakpoint }: AssemblyViewProps) {
  const [addressInput, setAddressInput] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const pcRowRef = useRef<HTMLDivElement>(null);
  const jumpTargetRowRef = useRef<HTMLDivElement>(null);
  // Track which address is being highlighted (for fade animation)
  const [highlightedAddress, setHighlightedAddress] = useState<bigint | null>(null);
  // Track which jump target is being hovered (for live highlight)
  const [hoveredJumpTarget, setHoveredJumpTarget] = useState<bigint | null>(null);
  // Resizable column widths
  const [columnWidths, setColumnWidths] = useState<ColumnWidths>(getInitialColumnWidths);
  // Context menu for right-click
  const { contextMenu, contextMenuRef, openContextMenu, closeContextMenu } = useContextMenu<{ address: string }>();

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
    pcAddress: address,
    registers,
    resolveSymbol,
  });

  // Handle column resize drag
  const handleColumnResizeStart = useCallback((column: keyof ColumnWidths, e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = columnWidths[column];

    const onMouseMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startX;
      setColumnWidths(prev => ({
        ...prev,
        [column]: Math.max(MIN_COL_WIDTH, startWidth + delta),
      }));
    };

    const onMouseUp = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      setColumnWidths(prev => {
        try { localStorage.setItem(COLUMN_WIDTHS_KEY, JSON.stringify(prev)); } catch {}
        return prev;
      });
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, [columnWidths]);

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

  // Scroll to PC when pcAddress changes or when instructions load (e.g., navigating back)
  // This ensures PC is always visible after stepping or when returning to a function with PC
  // But only if there's no jump target (user navigation takes priority)
  useEffect(() => {
    if (jumpTargetAddress === null && pcAddress !== null && pcRowRef.current) {
      // Use scrollIntoView to ensure PC row is visible
      // 'center' keeps it roughly centered, 'nearest' only scrolls if needed
      pcRowRef.current.scrollIntoView({ block: 'center', behavior: 'auto' });
    }
  }, [pcAddress, instructions, jumpTargetAddress]);

  // Scroll to and highlight jump target when navigating (clicking call/jump destinations)
  useEffect(() => {
    if (jumpTargetAddress !== null && instructions.length > 0 && jumpTargetRowRef.current) {
      // Scroll to the jump target
      jumpTargetRowRef.current.scrollIntoView({ block: 'center', behavior: 'auto' });
      // Trigger highlight animation
      setHighlightedAddress(jumpTargetAddress);
      // Clear highlight after animation (1 second)
      const timer = setTimeout(() => {
        setHighlightedAddress(null);
      }, 1000);
      return () => clearTimeout(timer);
    }
  }, [jumpTargetAddress, instructions]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.altKey && e.key === "ArrowLeft") {
        e.preventDefault();
        goBack();
      } else if (e.altKey && e.key === "ArrowRight") {
        e.preventDefault();
        goForward();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [goBack, goForward]);

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

  // Determine content to show
  const showEmptyState = !sessionId || (address == null && instructions.length === 0 && !error && !isLoading);
  const showErrorState = error !== null;
  const showLoadingState = isLoading && instructions.length === 0 && !error;
  const showInstructions = instructions.length > 0;

  return (
    <div ref={containerRef} data-capture-mouse-nav className="absolute inset-0 flex flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-2 p-2 border-b border-border bg-muted/30 shrink-0">
        {/* Go-to address input */}
        <div className="flex items-center gap-1">
          <Input
            placeholder="rip, symbol, rax+0x10..."
            value={addressInput}
            onChange={(e) => setAddressInput(sanitizeAddressInput(e.target.value))}
            onKeyDown={(e) => e.key === "Enter" && handleGoTo()}
            className="w-48 h-7 text-xs font-mono"
          />
          <Button variant="outline" size="sm" onClick={handleGoTo} className="h-7 px-2">
            Go
          </Button>
        </div>

        {/* Navigation back/forward */}
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            className="h-7 w-7"
            onClick={goBack}
            disabled={!canGoBack}
            title="Go back (Alt+Left)"
          >
            <ArrowLeft className="h-3 w-3" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="h-7 w-7"
            onClick={goForward}
            disabled={!canGoForward}
            title="Go forward (Alt+Right)"
          >
            <ArrowRight className="h-3 w-3" />
          </Button>
        </div>

        {/* Refresh */}
        <Button
          variant="outline"
          size="icon"
          className="h-7 w-7"
          onClick={refresh}
          disabled={isLoading}
          title="Refresh"
        >
          <RefreshCw className={cn("h-3 w-3", isLoading && "animate-spin")} />
        </Button>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Bytes column toggle */}
        <div className="flex items-center gap-2">
          <Label htmlFor="show-bytes" className="text-xs">Bytes</Label>
          <Switch
            id="show-bytes"
            checked={showBytes}
            onCheckedChange={toggleBytesColumn}
            className="h-4 w-7"
          />
        </div>
      </div>

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
      <ScrollArea className="flex-1 min-h-0">
        {/* Empty state */}
        {showEmptyState && (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
            <div className="text-center">
              <Cpu className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p className="text-base font-medium">No disassembly available</p>
              <p className="text-sm mt-1">Address information will appear here when debugging</p>
            </div>
          </div>
        )}

        {/* Error state */}
        {showErrorState && (
          <div className="flex items-center justify-center h-full text-red-500 p-4">
            <div className="text-center">
              <p>Error loading disassembly:</p>
              <p className="text-sm mt-1 font-mono">{error}</p>
            </div>
          </div>
        )}

        {/* Loading state */}
        {showLoadingState && (
          <div className="flex items-center justify-center h-full text-muted-foreground p-4">
            <div className="text-center">
              <Cpu className="h-8 w-8 mx-auto mb-2 animate-pulse" />
              <p>Loading disassembly...</p>
            </div>
          </div>
        )}

        {/* Instructions list */}
        {showInstructions && (
          <div
            ref={scrollContainerRef}
            className="font-mono text-xs"
          >
            {instructions.map((inst, index) => {
              const instAddrUpper = inst.address.toUpperCase();
              const isPC = pcAddress !== null && instAddrUpper === `0X${pcAddress.toString(16).toUpperCase()}`;
              const isJumpTarget = jumpTargetAddress !== null && instAddrUpper === `0X${jumpTargetAddress.toString(16).toUpperCase()}`;
              const isHighlighted = highlightedAddress !== null && instAddrUpper === `0X${highlightedAddress.toString(16).toUpperCase()}`;
              const isHoverTarget = hoveredJumpTarget !== null && instAddrUpper === `0X${hoveredJumpTarget.toString(16).toUpperCase()}`;

              // Determine which ref to use (jump target takes priority for scrolling)
              let rowRef: React.Ref<HTMLDivElement> | undefined;
              if (isJumpTarget) {
                rowRef = jumpTargetRowRef;
              } else if (isPC) {
                rowRef = pcRowRef;
              }

              const hasBreakpoint = breakpointAddresses?.has(inst.address.toUpperCase()) ?? false;

              return (
                <InstructionRow
                  key={`${inst.address}-${index}`}
                  instruction={inst}
                  isPC={isPC}
                  isHighlighted={isHighlighted}
                  isHoverTarget={isHoverTarget}
                  hasBreakpoint={hasBreakpoint}
                  showBytes={showBytes}
                  columnWidths={columnWidths}
                  onJumpTargetClick={handleJumpTargetClick}
                  onJumpTargetHover={handleJumpTargetHover}
                  onContextMenu={(e, addr) => openContextMenu(e, { address: addr })}
                  rowRef={rowRef}
                />
              );
            })}
          </div>
        )}
      </ScrollArea>

      {/* Quick Emulation footer */}
      <EmulationQuickView sessionId={sessionId} isPaused={isPaused} pcAddress={address} />

      {/* Context Menu */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="fixed z-50 bg-popover text-popover-foreground rounded-md border shadow-md py-1 min-w-[180px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          {onToggleBreakpoint && (
            <button
              className="w-full px-3 py-1.5 text-sm text-left hover:bg-accent hover:text-accent-foreground flex items-center gap-2"
              onClick={() => {
                onToggleBreakpoint(contextMenu.data.address);
                closeContextMenu();
              }}
            >
              {breakpointAddresses?.has(contextMenu.data.address.toUpperCase()) ? "Remove Breakpoint" : "Toggle Breakpoint"}
            </button>
          )}
          <button
            className="w-full px-3 py-1.5 text-sm text-left hover:bg-accent hover:text-accent-foreground flex items-center gap-2"
            onClick={async () => {
              await navigator.clipboard.writeText(contextMenu.data.address);
              closeContextMenu();
            }}
          >
            Copy Address
          </button>
        </div>
      )}
    </div>
  );
}

// Instruction row component
interface InstructionRowProps {
  instruction: Instruction;
  isPC: boolean;
  isHighlighted: boolean;
  isHoverTarget: boolean;
  hasBreakpoint: boolean;
  showBytes: boolean;
  columnWidths: ColumnWidths;
  onJumpTargetClick: (target: string) => void;
  onJumpTargetHover: (target: string | null) => void;
  onContextMenu: (e: React.MouseEvent, address: string) => void;
  rowRef?: React.Ref<HTMLDivElement>;
}

function InstructionRow({ instruction, isPC, isHighlighted, isHoverTarget, hasBreakpoint, showBytes, columnWidths, onJumpTargetClick, onJumpTargetHover, onContextMenu, rowRef }: InstructionRowProps) {
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
      ref={rowRef}
      className={cn(
        "flex items-center hover:bg-muted/30 px-2 py-0.5",
        isPC && "bg-yellow-100 dark:bg-yellow-900/40",
        isHighlighted && "animate-highlight-fade",
        isHoverTarget && "bg-blue-100 dark:bg-blue-900/40"
      )}
      onContextMenu={(e) => onContextMenu(e, instruction.address)}
    >
      {/* PC indicator */}
      <span className="w-4 shrink-0 text-yellow-600 dark:text-yellow-400">
        {isPC && <ChevronRight className="h-3 w-3" />}
      </span>

      {/* Breakpoint indicator */}
      <span className="w-4 shrink-0 flex items-center justify-center">
        {hasBreakpoint && <Circle className="h-2.5 w-2.5 fill-red-500 text-red-500" />}
      </span>

      {/* Address/Symbol column */}
      <span className="shrink-0 text-muted-foreground truncate" style={{ width: columnWidths.symbol }} title={instruction.symbol}>
        {instruction.symbol}
      </span>

      {/* Bytes column (conditional) */}
      {showBytes && (
        <span className="shrink-0 text-gray-500 truncate" style={{ width: columnWidths.bytes }} title={instruction.bytes}>
          {instruction.bytes}
        </span>
      )}

      {/* Mnemonic - color coded */}
      <span
        className={cn(
          "shrink-0",
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
