import { useState, useRef, useEffect, useMemo, useCallback, memo } from "react";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { ScrollArea } from "./ui/scroll-area";
import { VirtualizedList } from "./ui/virtualized-list";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { cn } from "@/lib/utils";
import { QuickEmulationState, QuickEmulationResult } from "@/hooks/useQuickEmulation";
import { parseTenetTrace } from "@/lib/tenetParser";

interface EmulationQuickViewProps {
  emulation: QuickEmulationState;
  onNavigateToAddress?: (hexAddress: string) => void;
}

function formatTimingUs(us: number): string {
  return `${(us / 1000).toFixed(1)}ms`;
}

const HEIGHT_KEY = "assembly-quick-emulation-height";
const DEFAULT_HEIGHT = 180;
const MIN_HEIGHT = 60;

function getInitialHeight(): number {
  try {
    const stored = localStorage.getItem(HEIGHT_KEY);
    if (stored) {
      const val = parseInt(stored, 10);
      if (!isNaN(val)) return Math.max(MIN_HEIGHT, val);
    }
  } catch {}
  return DEFAULT_HEIGHT;
}

/** Parse label from a quick emulation result (no instruction distance —
 *  distance is only meaningful from the trace, not from reachability modes) */
function parseSummaryRow(result: QuickEmulationResult | null, kind: "syscall" | "module"): {
  label: string;
  muted: boolean;
  finalPc: string | null;
} {
  if (!result) return { label: "...", muted: true, finalPc: null };

  if (result.stop_reason === "InstructionLimit") {
    return { label: "Not reached", muted: true, finalPc: null };
  }

  const reason = result.stop_reason;
  const finalPc = result.final_pc ?? null;

  if (kind === "syscall") {
    // stop_reason like "Syscall(ntdll!NtWriteFile+0x14)" or "Syscall(0x7FFC...)"
    const match = reason.match(/^Syscall\((.+)\)$/);
    return { label: match ? match[1] : reason, muted: false, finalPc };
  }

  // Module transition: "ModuleTransition(ntdll->kernelbase@SomeFunc+0x10)"
  const moduleMatch = reason.match(/^ModuleTransition\(.+@(.+)\)$/);
  if (moduleMatch) {
    return { label: moduleMatch[1], muted: false, finalPc };
  }

  return { label: reason, muted: false, finalPc };
}

interface TraceLine {
  index: number;
  address: string;
  mnemonic: string;
  opStr: string;
  changes: string;
  memory: string;
  tooltip: string;
}

const TRACE_ROW_HEIGHT = 18;

function VirtualizedTraceLines({
  height,
  traceLines,
  hasAnyData,
  isLoading,
  onRowEnter,
  onRowMove,
  onRowLeave,
}: {
  height: number;
  traceLines: TraceLine[];
  hasAnyData: boolean;
  isLoading: boolean;
  onRowEnter: (index: number, e: React.MouseEvent) => void;
  onRowMove: (pos: { x: number; y: number }) => void;
  onRowLeave: () => void;
}) {
  if (traceLines.length === 0 && !hasAnyData && !isLoading) {
    return (
      <ScrollArea style={{ height }}>
        <div className="px-3 py-2 text-muted-foreground text-center">
          Pause the debugger to see quick emulation results
        </div>
      </ScrollArea>
    );
  }

  if (traceLines.length === 0) {
    return <ScrollArea style={{ height }} />;
  }

  return (
    <VirtualizedList
      items={traceLines}
      rowHeight={TRACE_ROW_HEIGHT}
      style={{ height }}
      renderItem={(line) => (
        <div
          className="flex items-center px-2 whitespace-nowrap hover:bg-muted/50 h-full"
          onMouseEnter={(e) => onRowEnter(line.index, e)}
          onMouseMove={(e) => onRowMove({ x: e.clientX, y: e.clientY })}
          onMouseLeave={onRowLeave}
        >
          <span className="text-muted-foreground w-8 shrink-0 text-right mr-2">
            {line.index}
          </span>
          <span className="text-muted-foreground shrink-0 mr-3" style={{ minWidth: 180 }}>
            {line.address.length > 35 ? line.address.slice(0, 34) + "\u2026" : line.address}
          </span>
          <span className="shrink-0 mr-3" style={{ minWidth: 140 }}>
            <span className="text-blue-400">{line.mnemonic}</span>
            {line.opStr && <> {line.opStr}</>}
          </span>
          {(line.changes || line.memory) && (
            <>
              {line.changes && <span className="text-yellow-500 mr-1">{line.changes}</span>}
              {line.changes && line.memory && <span className="text-muted-foreground mr-1">, </span>}
              {line.memory && <span className="text-blue-500">{line.memory}</span>}
            </>
          )}
        </div>
      )}
    />
  );
}

export const EmulationQuickView = memo(function EmulationQuickView({ emulation, onNavigateToAddress }: EmulationQuickViewProps) {
  const [height, setHeight] = useState(getInitialHeight);
  const rootRef = useRef<HTMLDivElement>(null);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = height;
    // Compute dynamic max from parent flex container, reserving 80px for toolbar + status bar
    const parentHeight = rootRef.current?.parentElement?.clientHeight;
    const maxHeight = parentHeight ? parentHeight - 80 : 800;

    const onMouseMove = (ev: MouseEvent) => {
      // Dragging up (negative deltaY) should increase height
      const delta = startY - ev.clientY;
      setHeight(Math.max(MIN_HEIGHT, Math.min(maxHeight, startHeight + delta)));
    };

    const onMouseUp = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      // Persist final height
      setHeight(h => {
        try { localStorage.setItem(HEIGHT_KEY, String(h)); } catch {}
        return h;
      });
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, [height]);

  const {
    syscallResult,
    moduleResult,
    traceResult,
    traceMode,
    isLoading,
    toggleTraceMode,
    maxInstructions,
    setMaxInstructions,
    collapsed,
    toggleCollapsed,
  } = emulation;

  // Hover tooltip state (trace rows)
  const [visibleTooltipRow, setVisibleTooltipRow] = useState<number | null>(null);
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tooltipHoveredRef = useRef(false);

  // Stats popover state
  const [statsPopover, setStatsPopover] = useState<string | null>(null);
  const [statsPopoverPos, setStatsPopoverPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const statsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statsHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statsHoveredRef = useRef(false);

  useEffect(() => {
    return () => {
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      if (statsTimerRef.current) clearTimeout(statsTimerRef.current);
      if (statsHideTimerRef.current) clearTimeout(statsHideTimerRef.current);
    };
  }, []);

  const handleRowEnter = useCallback((index: number, e: React.MouseEvent) => {
    if (hideTimerRef.current) { clearTimeout(hideTimerRef.current); hideTimerRef.current = null; }
    setTooltipPos({ x: e.clientX, y: e.clientY });
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => setVisibleTooltipRow(index), 1000);
  }, []);

  const dismissTooltip = useCallback(() => {
    setVisibleTooltipRow(null);
    if (hoverTimerRef.current) { clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null; }
  }, []);

  const handleRowLeave = useCallback(() => {
    if (hoverTimerRef.current) { clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null; }
    // Delay hide so cursor can reach the tooltip
    hideTimerRef.current = setTimeout(() => {
      if (!tooltipHoveredRef.current) dismissTooltip();
    }, 150);
  }, [dismissTooltip]);

  const handleTooltipEnter = useCallback(() => {
    tooltipHoveredRef.current = true;
    if (hideTimerRef.current) { clearTimeout(hideTimerRef.current); hideTimerRef.current = null; }
  }, []);

  const handleTooltipLeave = useCallback(() => {
    tooltipHoveredRef.current = false;
    dismissTooltip();
  }, [dismissTooltip]);

  // Stats popover handlers
  const dismissStatsPopover = useCallback(() => {
    setStatsPopover(null);
    if (statsTimerRef.current) { clearTimeout(statsTimerRef.current); statsTimerRef.current = null; }
  }, []);

  const handleStatsEnter = useCallback((statsText: string, e: React.MouseEvent) => {
    if (statsHideTimerRef.current) { clearTimeout(statsHideTimerRef.current); statsHideTimerRef.current = null; }
    setStatsPopoverPos({ x: e.clientX, y: e.clientY });
    if (statsTimerRef.current) clearTimeout(statsTimerRef.current);
    statsTimerRef.current = setTimeout(() => setStatsPopover(statsText), 500);
  }, []);

  const handleStatsLeave = useCallback(() => {
    if (statsTimerRef.current) { clearTimeout(statsTimerRef.current); statsTimerRef.current = null; }
    statsHideTimerRef.current = setTimeout(() => {
      if (!statsHoveredRef.current) dismissStatsPopover();
    }, 150);
  }, [dismissStatsPopover]);

  const handleStatsPopoverEnter = useCallback(() => {
    statsHoveredRef.current = true;
    if (statsHideTimerRef.current) { clearTimeout(statsHideTimerRef.current); statsHideTimerRef.current = null; }
  }, []);

  const handleStatsPopoverLeave = useCallback(() => {
    statsHoveredRef.current = false;
    dismissStatsPopover();
  }, [dismissStatsPopover]);

  const syscall = parseSummaryRow(syscallResult, "syscall");
  const module = parseSummaryRow(moduleResult, "module");

  // Parse trace lines
  const traceLines = useMemo(() => {
    if (!traceResult) return [];

    if (traceResult.mode === "InstructionTrace" && traceResult.trace_text) {
      const entries = parseTenetTrace(traceResult.trace_text);
      const instrMap = new Map<string, { symbol: string | null; mnemonic: string; op_str: string }>();
      for (const info of traceResult.instruction_info) {
        instrMap.set(info.address.toUpperCase(), info);
      }

      return entries.map((entry, i) => {
        const pcKey = 'rip' in entry.registers ? 'rip' : 'pc' in entry.registers ? 'pc' : Object.keys(entry.registers)[0] || 'rip';
        const pcValue = entry.registers[pcKey] || "";
        const info = instrMap.get(pcValue.toUpperCase());

        // Changed registers
        let changes = "";
        if (i === 0) {
          changes = "(initial)";
        } else {
          const prev = entries[i - 1];
          const parts: string[] = [];
          for (const [key, value] of Object.entries(entry.registers)) {
            if (key === pcKey) continue;
            if (prev.registers[key] !== value) parts.push(`${key}=${value}`);
          }
          changes = parts.join(", ");
        }

        // Memory accesses
        const memParts: string[] = [];
        for (const m of entry.memoryReads) memParts.push(`R ${m.address} [${m.data}]`);
        for (const m of entry.memoryWrites) memParts.push(`W ${m.address} [${m.data}]`);

        // Tooltip: full register state
        const tooltip = Object.entries(entry.registers)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\n");

        return {
          index: i,
          address: info?.symbol ?? pcValue,
          mnemonic: info?.mnemonic ?? "",
          opStr: info?.op_str ?? "",
          changes,
          memory: memParts.join(", "),
          tooltip,
        };
      });
    }

    if (traceResult.mode === "BasicBlock" && traceResult.basic_blocks.length > 0) {
      const instrMap = new Map<string, { symbol: string | null; mnemonic: string; op_str: string }>();
      for (const info of traceResult.instruction_info) {
        instrMap.set(info.address.toUpperCase(), info);
      }
      return traceResult.basic_blocks.map((addr, i) => {
        const info = instrMap.get(addr.toUpperCase());
        return {
          index: i,
          address: info?.symbol ?? addr,
          mnemonic: info?.mnemonic ?? "",
          opStr: info?.op_str ?? "",
          changes: "",
          memory: "",
          tooltip: info?.symbol ?? addr,
        };
      });
    }

    return [];
  }, [traceResult]);

  // Derive accurate distances from trace data when available
  // (the separate Syscall/ModuleTransition emulations may count differently)
  const traceDistances = useMemo(() => {
    const result: { syscall?: number } = {};
    for (const line of traceLines) {
      if (result.syscall === undefined && line.mnemonic === "syscall") {
        result.syscall = line.index;
        break;
      }
    }
    return result;
  }, [traceLines]);

  const hasAnyData = syscallResult || moduleResult || traceResult;
  const dimmed = isLoading && hasAnyData;

  return (
    <div ref={rootRef} className="shrink-0 border-t border-border bg-muted/20">
      {/* Resize handle */}
      <div
        className="h-1 cursor-row-resize hover:bg-blue-500/30 active:bg-blue-500/50 transition-colors"
        onMouseDown={handleResizeStart}
      />
      {/* Header */}
      <div
        className="flex items-center justify-between px-2 py-1 cursor-pointer hover:bg-muted/40 select-none"
        onClick={toggleCollapsed}
      >
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          {collapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          <span className="font-medium">Quick Emulation</span>
          {isLoading && <Loader2 className="h-3 w-3 animate-spin ml-1" />}
        </div>
        {!collapsed && (
          <Button
            variant="outline"
            size="xs"
            onClick={(e) => { e.stopPropagation(); toggleTraceMode(); }}
          >
            {traceMode === "InstructionTrace" ? "Instructions" : "Basic blocks"}
          </Button>
        )}
      </div>

      {/* Body */}
      {!collapsed && (
        <div className={`text-xs font-mono ${dimmed ? "opacity-50" : ""}`}>
          {/* Summary rows - fixed above scroll */}
          <div className="px-3 py-1 space-y-0.5 border-b border-border/50">
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground w-24 shrink-0">Next Syscall:</span>
              <span
                className={cn(
                  syscall.muted ? "text-muted-foreground" : "text-green-500",
                  !syscall.muted && onNavigateToAddress && syscall.finalPc && "cursor-pointer hover:underline hover:text-green-400"
                )}
                onClick={() => {
                  if (!syscall.muted && onNavigateToAddress && syscall.finalPc) {
                    onNavigateToAddress(syscall.finalPc);
                  }
                }}
              >
                {syscall.label}
              </span>
              {traceDistances.syscall !== undefined && (
                <span className="text-muted-foreground ml-auto">
                  {traceDistances.syscall.toLocaleString()} instr away
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground w-24 shrink-0">Next Module:</span>
              <span
                className={cn(
                  module.muted ? "text-muted-foreground" : "text-green-500",
                  !module.muted && onNavigateToAddress && module.finalPc && "cursor-pointer hover:underline hover:text-green-400"
                )}
                onClick={() => {
                  if (!module.muted && onNavigateToAddress && module.finalPc) {
                    onNavigateToAddress(module.finalPc);
                  }
                }}
              >
                {module.label}
              </span>
            </div>
            <div className="flex items-center gap-2 text-muted-foreground">
              <span className="w-24 shrink-0">Emulation:</span>
              {hasAnyData && (
                <span>
                  {[
                    syscallResult && (
                      <span
                        key="s"
                        className="cursor-default hover:text-foreground"
                        onMouseEnter={(e) => handleStatsEnter(syscallResult.stats_text, e)}
                        onMouseMove={(e) => setStatsPopoverPos({ x: e.clientX, y: e.clientY })}
                        onMouseLeave={handleStatsLeave}
                      >
                        syscall {formatTimingUs(syscallResult.emulation_time_us)}
                      </span>
                    ),
                    moduleResult && (
                      <span
                        key="m"
                        className="cursor-default hover:text-foreground"
                        onMouseEnter={(e) => handleStatsEnter(moduleResult.stats_text, e)}
                        onMouseMove={(e) => setStatsPopoverPos({ x: e.clientX, y: e.clientY })}
                        onMouseLeave={handleStatsLeave}
                      >
                        module {formatTimingUs(moduleResult.emulation_time_us)}
                      </span>
                    ),
                    traceResult && (
                      <span
                        key="t"
                        className="cursor-default hover:text-foreground"
                        onMouseEnter={(e) => handleStatsEnter(traceResult.stats_text, e)}
                        onMouseMove={(e) => setStatsPopoverPos({ x: e.clientX, y: e.clientY })}
                        onMouseLeave={handleStatsLeave}
                      >
                        trace {formatTimingUs(traceResult.emulation_time_us)}
                      </span>
                    ),
                  ].filter(Boolean).reduce<React.ReactNode[]>((acc, el, i) => {
                    if (i > 0) acc.push(", ");
                    acc.push(el);
                    return acc;
                  }, [])}
                </span>
              )}
              <span className="ml-auto flex items-center gap-1">
                limit
                <Input
                  key={maxInstructions}
                  type="text"
                  inputSize="inline"
                  className="w-14 text-right font-mono"
                  defaultValue={maxInstructions.toLocaleString()}
                  onClick={(e) => e.stopPropagation()}
                  onFocus={(e) => e.target.select()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      const val = parseInt((e.target as HTMLInputElement).value.replace(/,/g, ""), 10);
                      if (!isNaN(val) && val > 0) setMaxInstructions(val);
                      (e.target as HTMLInputElement).blur();
                    }
                  }}
                  onBlur={(e) => {
                    const val = parseInt(e.target.value.replace(/,/g, ""), 10);
                    if (!isNaN(val) && val > 0) {
                      setMaxInstructions(val);
                      e.target.value = val.toLocaleString();
                    } else {
                      e.target.value = maxInstructions.toLocaleString();
                    }
                  }}
                />
              </span>
            </div>
          </div>

          {/* Trace lines - scrollable + virtualized */}
          <VirtualizedTraceLines
            height={height}
            traceLines={traceLines}
            hasAnyData={!!hasAnyData}
            isLoading={isLoading}
            onRowEnter={handleRowEnter}
            onRowMove={setTooltipPos}
            onRowLeave={handleRowLeave}
          />
        </div>
      )}

      {/* Stats popover (appears on hover over timing values) */}
      {statsPopover && (
        <div
          className="fixed z-50 bg-popover border border-border rounded shadow-lg p-2 text-xs font-mono select-text"
          onMouseEnter={handleStatsPopoverEnter}
          onMouseLeave={handleStatsPopoverLeave}
          style={{
            left: Math.min(statsPopoverPos.x + 12, window.innerWidth - 420),
            top: Math.min(statsPopoverPos.y + 12, window.innerHeight - 200),
          }}
        >
          <table className="border-separate" style={{ borderSpacing: "8px 1px" }}>
            <tbody>
              {statsPopover.split(" | ").map((part, i) => {
                const [label, ...rest] = part.split(": ");
                const value = rest.join(": ");
                return (
                  <tr key={i}>
                    <td className="text-muted-foreground text-right">{label}:</td>
                    <td>{value}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Hover tooltip (appears after 1s delay, interactive so user can copy) */}
      {visibleTooltipRow !== null && traceLines[visibleTooltipRow] && (() => {
        const line = traceLines[visibleTooltipRow];
        const isTruncated = line.address.length > 35;
        return (
          <div
            className="fixed z-50 bg-popover border border-border rounded shadow-lg p-2 text-xs font-mono max-w-md select-text"
            onMouseEnter={handleTooltipEnter}
            onMouseLeave={handleTooltipLeave}
            style={{
              left: Math.min(tooltipPos.x + 12, window.innerWidth - 420),
              top: Math.min(tooltipPos.y + 12, window.innerHeight - 300),
            }}
          >
            {isTruncated && (
              <div className="text-green-500 mb-1">{line.address}</div>
            )}
            <div className="text-muted-foreground mb-1">
              {traceMode === "InstructionTrace"
                ? `Registers at step ${visibleTooltipRow}:`
                : `Block ${visibleTooltipRow}:`}
            </div>
            <pre className="whitespace-pre-wrap">{line.tooltip}</pre>
          </div>
        );
      })()}
    </div>
  );
});
