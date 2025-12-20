import { useState, useRef, useEffect, useCallback } from "react";
import { ScrollArea } from "./ui/scroll-area";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Switch } from "./ui/switch";
import { Label } from "./ui/label";
import { Cpu, ArrowLeft, ArrowRight, RefreshCw, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAssemblyView, Instruction } from "@/hooks/useAssemblyView";
import { RegisterContext, SymbolResolver, sanitizeAddressInput } from "@/lib/hexUtils";

interface AssemblyViewProps {
  sessionId?: string;
  address?: number;
  registers?: RegisterContext;
  resolveSymbol?: SymbolResolver;
}

export function AssemblyView({ sessionId, address, registers, resolveSymbol }: AssemblyViewProps) {
  const [addressInput, setAddressInput] = useState("");
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const pcRowRef = useRef<HTMLDivElement>(null);
  const jumpTargetRowRef = useRef<HTMLDivElement>(null);
  // Track which address is being highlighted (for fade animation)
  const [highlightedAddress, setHighlightedAddress] = useState<bigint | null>(null);
  // Track which jump target is being hovered (for live highlight)
  const [hoveredJumpTarget, setHoveredJumpTarget] = useState<bigint | null>(null);

  const {
    instructions,
    pcAddress,
    functionName,
    functionStart,
    functionEnd,
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

  // Determine content to show
  const showEmptyState = !sessionId || (address == null && instructions.length === 0 && !error && !isLoading);
  const showErrorState = error !== null;
  const showLoadingState = isLoading && instructions.length === 0 && !error;
  const showInstructions = instructions.length > 0;

  return (
    <div className="absolute inset-0 flex flex-col overflow-hidden">
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
            className="font-mono text-xs bg-gray-50 dark:bg-gray-900"
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

              return (
                <InstructionRow
                  key={`${inst.address}-${index}`}
                  instruction={inst}
                  isPC={isPC}
                  isHighlighted={isHighlighted}
                  isHoverTarget={isHoverTarget}
                  showBytes={showBytes}
                  onJumpTargetClick={handleJumpTargetClick}
                  onJumpTargetHover={handleJumpTargetHover}
                  rowRef={rowRef}
                />
              );
            })}
          </div>
        )}
      </ScrollArea>

      {/* Status bar - always visible */}
      <div className="flex items-center gap-4 px-2 py-1 border-t border-border bg-muted/30 text-xs text-muted-foreground shrink-0">
        {functionName && (
          <span className="font-medium">{functionName}</span>
        )}
        {functionStart !== null && functionEnd !== null && (
          <span>
            {functionStart.toString(16).toUpperCase()} - {functionEnd.toString(16).toUpperCase()}
          </span>
        )}
        <span className="ml-auto">{instructions.length > 0 ? `${instructions.length} instructions` : 'No data'}</span>
      </div>
    </div>
  );
}

// Instruction row component
interface InstructionRowProps {
  instruction: Instruction;
  isPC: boolean;
  isHighlighted: boolean;
  isHoverTarget: boolean;
  showBytes: boolean;
  onJumpTargetClick: (target: string) => void;
  onJumpTargetHover: (target: string | null) => void;
  rowRef?: React.Ref<HTMLDivElement>;
}

function InstructionRow({ instruction, isPC, isHighlighted, isHoverTarget, showBytes, onJumpTargetClick, onJumpTargetHover, rowRef }: InstructionRowProps) {
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
    >
      {/* PC indicator */}
      <span className="w-4 shrink-0 text-yellow-600 dark:text-yellow-400">
        {isPC && <ChevronRight className="h-3 w-3" />}
      </span>

      {/* Address/Symbol column */}
      <span className="w-80 shrink-0 text-muted-foreground truncate" title={instruction.symbol}>
        {instruction.symbol}
      </span>

      {/* Bytes column (conditional) */}
      {showBytes && (
        <span className="w-36 shrink-0 text-gray-500 truncate" title={instruction.bytes}>
          {instruction.bytes}
        </span>
      )}

      {/* Mnemonic - color coded */}
      <span
        className={cn(
          "w-16 shrink-0",
          is_call && "text-green-500",
          is_jump && !is_call && "text-blue-500",
          is_ret && "text-red-500",
          !is_call && !is_jump && !is_ret && "text-blue-400"
        )}
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
