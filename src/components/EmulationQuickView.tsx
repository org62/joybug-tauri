import { useState, useRef, useMemo, useCallback, memo } from "react";
import { Copy, Loader2 } from "lucide-react";
import { copyToClipboard } from "@/lib/clipboard";
import { ScrollArea } from "./ui/scroll-area";
import { VirtualizedList } from "./ui/virtualized-list";
import { Button } from "./ui/button";
import { HistoryInput } from "./ui/history-input";
import { pushInputHistory } from "@/lib/inputHistory";
import { cn, DATA_ROW_HEIGHT } from "@/lib/utils";
import { QuickEmulationState, QuickEmulationResult, EmulationToggle, TraceMode } from "@/hooks/useQuickEmulation";
import { buildTraceSteps, buildCallSteps, formatStepValues, stepLabel, type TraceStep } from "@/lib/emulationTrace";
import { TraceStepDetails } from "./EmulationTraceStep";
import { useHoverPopup } from "@/hooks/useHoverPopup";
import { HoverPopupPanel } from "@/components/ui/hover-popup";
import { useColumnWidths } from "@/hooks/useColumnWidths";
import { useHeaderScrollSync } from "@/hooks/useHeaderScrollSync";
import { ResizableHeaderCell } from "./ui/resizable-header-cell";
import { Badge } from "./ui/badge";

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

const TRACE_ROW_HEIGHT = DATA_ROW_HEIGHT;

// Resizable table columns of the trace listing; the "Emu values" column takes
// the rest. Persisted like the assembly listing's columns.
type TraceColumnWidths = { index: number; address: number; asm: number };
const TRACE_COLUMNS_KEY = "assembly-quick-emulation-columns";
const DEFAULT_TRACE_COLUMNS: TraceColumnWidths = { index: 44, address: 220, asm: 200 };
const TRACE_VALUES_MIN = 240;

// Quick picks for the trace limit, offered in the input's recall dropdown.
const LIMIT_PRESETS = [1_000, 10_000, 100_000].map((n) => n.toLocaleString());

const TRACE_MODE_LABEL: Record<TraceMode, string> = {
  InstructionTrace: "Per instruction",
  BasicBlock: "Basic blocks",
  Calls: "Calls",
};

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
  traceLines: TraceStep[];
  hasAnyData: boolean;
  isLoading: boolean;
  /** `position` is the row's index in `traceLines` (not the trace step). */
  onRowEnter: (e: React.MouseEvent, position: number) => void;
  onRowMove: (e: React.MouseEvent) => void;
  onRowLeave: () => void;
}) {
  const { columnWidths, handleColumnResizeStart } = useColumnWidths<keyof TraceColumnWidths>(TRACE_COLUMNS_KEY, DEFAULT_TRACE_COLUMNS);
  const rowMinWidth = `${16 /* px-2 */ + columnWidths.index + columnWidths.address + columnWidths.asm + TRACE_VALUES_MIN}px`;
  const { headerInnerRef, handleViewportScroll, handleHeaderScroll } = useHeaderScrollSync(rowMinWidth);

  let body: React.ReactNode;
  if (traceLines.length === 0 && !hasAnyData && !isLoading) {
    body = (
      <ScrollArea className="flex-1 min-h-0">
        <div className="px-3 py-2 text-muted-foreground text-center">
          Pause the debugger to see quick emulation results
        </div>
      </ScrollArea>
    );
  } else if (traceLines.length === 0) {
    body = <ScrollArea className="flex-1 min-h-0" />;
  } else {
    body = (
      <VirtualizedList
        items={traceLines}
        rowHeight={TRACE_ROW_HEIGHT}
        className="flex-1 min-h-0"
        minContentWidth={rowMinWidth}
        onViewportScroll={handleViewportScroll}
        renderItem={(line, position) => (
          <div
            data-testid="emulation-trace-row"
            className="flex items-center px-2 whitespace-nowrap hover:bg-muted/50 h-full"
            onMouseEnter={(e) => onRowEnter(e, position)}
            onMouseMove={onRowMove}
            onMouseLeave={onRowLeave}
          >
            <span className="text-muted-foreground shrink-0 truncate pr-1 text-right" style={{ width: columnWidths.index }}>
              {line.index}
            </span>
            <span className="text-muted-foreground shrink-0 truncate pr-1" style={{ width: columnWidths.address }} title={stepLabel(line)}>
              {stepLabel(line)}
            </span>
            <span className="shrink-0 truncate pr-1" style={{ width: columnWidths.asm }}>
              {line.mnemonic}
              {line.opStr && <> {line.opStr}</>}
            </span>
            <span className="flex-1 truncate flex items-center gap-1" style={{ minWidth: TRACE_VALUES_MIN }}>
              {line.kind && (
                <Badge variant="secondary" size="xs" className="shrink-0 px-1 py-0 leading-none font-mono">
                  {line.kind} →
                </Badge>
              )}
              {line.changes && <span className="text-syn-accent">{line.changes}</span>}
              {line.changes && line.memory && <span className="text-muted-foreground">, </span>}
              {line.memory && <span className="text-foreground">{line.memory}</span>}
            </span>
          </div>
        )}
      />
    );
  }

  return (
    <div className="flex flex-col" style={{ height }}>
      {/* Column header — fixed vertically, follows horizontal scroll */}
      <div className="shrink-0 overflow-hidden border-b border-border/50" onScroll={handleHeaderScroll}>
        <div
          ref={headerInnerRef}
          style={{ minWidth: rowMinWidth }}
          className="flex items-center px-2 py-0.5 text-xs text-foreground/60 select-none"
        >
          <ResizableHeaderCell width={columnWidths.index} className="text-right" onResizeStart={(e) => handleColumnResizeStart("index", e)}>
            <span data-testid="emu-col-index">#</span>
          </ResizableHeaderCell>
          <ResizableHeaderCell width={columnWidths.address} onResizeStart={(e) => handleColumnResizeStart("address", e)}>
            <span data-testid="emu-col-address">Symbol / address</span>
          </ResizableHeaderCell>
          <ResizableHeaderCell width={columnWidths.asm} onResizeStart={(e) => handleColumnResizeStart("asm", e)}>
            <span data-testid="emu-col-asm">Asm</span>
          </ResizableHeaderCell>
          <span className="flex-1" data-testid="emu-col-values">Emu values</span>
        </div>
      </div>
      {body}
    </div>
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
    toggles,
    setToggle,
  } = emulation;

  // Two delayed hover popups over the footer: the per-row trace tooltip and
  // the stats popover behind each timing value. Both share the trigger/grace
  // contract with the disassembly listing's lightning popup.
  const tooltip = useHoverPopup<number>();
  const stats = useHoverPopup<string>(500);

  const syscall = parseSummaryRow(syscallResult, "syscall");
  const module = parseSummaryRow(moduleResult, "module");

  // Trace steps, from the shared builder (the same one the lightning
  // annotations use). Parsing is keyed on the payload alone so cycling to
  // Calls — a client-side view over the same trace — never re-parses it.
  const traceSteps = useMemo(
    () => (toggles.instructions ? buildTraceSteps(traceResult) : []),
    [traceResult, toggles.instructions],
  );
  const traceLines = useMemo(
    () => (traceMode === "Calls" ? buildCallSteps(traceSteps) : traceSteps),
    [traceSteps, traceMode],
  );

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
  const anyToggle = toggles.module || toggles.syscall || toggles.instructions;
  const dimmed = isLoading && hasAnyData;

  // Render the visible emulation output (summary + trace lines) as plain text,
  // with the trace columns aligned like the on-screen layout.
  const handleCopyLog = useCallback(() => {
    const lines: string[] = [];
    if (toggles.syscall) {
      lines.push(
        `Next Syscall: ${syscall.label}` +
          (traceDistances.syscall !== undefined
            ? ` (${traceDistances.syscall.toLocaleString()} instr away)`
            : ""),
      );
    }
    if (toggles.module) lines.push(`Next Module: ${module.label}`);
    const timings = [
      syscallResult && `syscall ${formatTimingUs(syscallResult.emulation_time_us)}`,
      moduleResult && `module ${formatTimingUs(moduleResult.emulation_time_us)}`,
      traceResult && `trace ${formatTimingUs(traceResult.emulation_time_us)}`,
    ]
      .filter(Boolean)
      .join(", ");
    if (timings) lines.push(`Emulation: ${timings}`);

    if (traceLines.length > 0) {
      lines.push("");
      const addrTexts = traceLines.map(stepLabel);
      const addrWidth = Math.max(...addrTexts.map((a) => a.length));
      const asmTexts = traceLines.map((l) => (l.opStr ? `${l.mnemonic} ${l.opStr}` : l.mnemonic));
      const asmWidth = Math.max(...asmTexts.map((a) => a.length));
      const idxWidth = String(traceLines.length - 1).length;
      traceLines.forEach((l, i) => {
        const extras = [l.kind && `${l.kind} →`, formatStepValues(l)].filter(Boolean).join(", ");
        lines.push(
          `${String(l.index).padStart(idxWidth)}  ${addrTexts[i].padEnd(addrWidth)}  ${asmTexts[i].padEnd(asmWidth)}${extras ? `  ${extras}` : ""}`.trimEnd(),
        );
      });
    }

    copyToClipboard(lines.join("\n"), "emulation log");
  }, [toggles.syscall, toggles.module, syscall.label, module.label, traceDistances.syscall, syscallResult, moduleResult, traceResult, traceLines]);

  const toggleButton = (name: EmulationToggle, label: string) => (
    <Button
      variant={toggles[name] ? "default" : "outline"}
      size="xs"
      aria-pressed={toggles[name]}
      data-testid={`emu-toggle-${name}`}
      onClick={() => setToggle(name, !toggles[name])}
    >
      {label}
    </Button>
  );

  return (
    <div ref={rootRef} className="shrink-0 border-t border-border bg-muted/20">
      {/* Resize handle — only meaningful while the trace listing is shown */}
      {toggles.instructions && (
        <div
          className="h-1 cursor-row-resize hover:bg-ring/40 active:bg-ring/60 transition-colors"
          onMouseDown={handleResizeStart}
        />
      )}
      {/* Header: title + the three independent probe toggles */}
      <div className="flex items-center justify-between px-2 py-1 select-none">
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <span className="font-medium">Quick Emulation</span>
          {isLoading && anyToggle && <Loader2 className="h-3 w-3 animate-spin ml-1" />}
        </div>
        <div className="flex items-center gap-1">
          {toggleButton("module", "Module")}
          {toggleButton("syscall", "Syscall")}
          {toggleButton("instructions", "Instructions")}
          {toggles.instructions && (
            <Button
              variant="outline"
              size="xs"
              title="Trace granularity"
              onClick={toggleTraceMode}
            >
              {TRACE_MODE_LABEL[traceMode]}
            </Button>
          )}
          <Button
            variant="outline"
            size="icon-xs"
            title="Copy emulation log"
            disabled={!hasAnyData}
            onClick={handleCopyLog}
          >
            <Copy />
          </Button>
        </div>
      </div>

      {/* Body: only the enabled probes */}
      {anyToggle && (
        <div className={`text-data font-mono ${dimmed ? "opacity-50" : ""}`}>
          {/* Summary rows - fixed above scroll */}
          <div className={cn("px-3 py-1 space-y-0.5", toggles.instructions && "border-b border-border/50")}>
            {toggles.syscall && (
              <div className="flex items-center gap-2" data-testid="emu-row-syscall">
                <span className="text-muted-foreground w-24 shrink-0">Next Syscall:</span>
                <span
                  className={cn(
                    syscall.muted ? "text-muted-foreground" : "text-syn-link",
                    !syscall.muted && onNavigateToAddress && syscall.finalPc && "cursor-pointer hover:underline"
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
            )}
            {toggles.module && (
              <div className="flex items-center gap-2" data-testid="emu-row-module">
                <span className="text-muted-foreground w-24 shrink-0">Next Module:</span>
                <span
                  className={cn(
                    module.muted ? "text-muted-foreground" : "text-syn-link",
                    !module.muted && onNavigateToAddress && module.finalPc && "cursor-pointer hover:underline"
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
            )}
            <div className="flex items-center gap-2 text-muted-foreground">
              <span className="w-24 shrink-0">Emulation:</span>
              {hasAnyData && (
                <span>
                  {[
                    syscallResult && (
                      <span
                        key="s"
                        className="cursor-default hover:text-foreground"
                        onMouseEnter={(e) => stats.show(e, syscallResult.stats_text)}
                        onMouseMove={stats.move}
                        onMouseLeave={stats.leave}
                      >
                        syscall {formatTimingUs(syscallResult.emulation_time_us)}
                      </span>
                    ),
                    moduleResult && (
                      <span
                        key="m"
                        className="cursor-default hover:text-foreground"
                        onMouseEnter={(e) => stats.show(e, moduleResult.stats_text)}
                        onMouseMove={stats.move}
                        onMouseLeave={stats.leave}
                      >
                        module {formatTimingUs(moduleResult.emulation_time_us)}
                      </span>
                    ),
                    traceResult && (
                      <span
                        key="t"
                        className="cursor-default hover:text-foreground"
                        onMouseEnter={(e) => stats.show(e, traceResult.stats_text)}
                        onMouseMove={stats.move}
                        onMouseLeave={stats.leave}
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
                <HistoryInput
                  historyKey="emu-instr-limit"
                  presets={LIMIT_PRESETS}
                  key={maxInstructions}
                  type="text"
                  inputSize="xs"
                  className="w-24 text-right font-mono"
                  defaultValue={maxInstructions.toLocaleString()}
                  onClick={(e) => e.stopPropagation()}
                  onFocus={(e) => e.target.select()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      const val = parseInt((e.target as HTMLInputElement).value.replace(/,/g, ""), 10);
                      if (!isNaN(val) && val > 0) {
                        pushInputHistory("emu-instr-limit", val.toLocaleString());
                        setMaxInstructions(val);
                      }
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
          {toggles.instructions && (
            <VirtualizedTraceLines
              height={height}
              traceLines={traceLines}
              hasAnyData={!!traceResult}
              isLoading={isLoading}
              onRowEnter={tooltip.show}
              onRowMove={tooltip.move}
              onRowLeave={tooltip.leave}
            />
          )}
        </div>
      )}

      {/* Stats popover (appears on hover over timing values) */}
      {stats.target && (
        <HoverPopupPanel
          x={stats.pos.x}
          y={stats.pos.y}
          height={200}
          {...stats.popupProps}
        >
          <table className="border-separate" style={{ borderSpacing: "8px 1px" }}>
            <tbody>
              {stats.target.split(" | ").map((part, i) => {
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
        </HoverPopupPanel>
      )}

      {/* Hover tooltip (appears after 1s delay, interactive so user can copy) */}
      {tooltip.target !== null && traceLines[tooltip.target] && (() => {
        const line = traceLines[tooltip.target];
        const label = stepLabel(line);
        return (
          <HoverPopupPanel
            x={tooltip.pos.x}
            y={tooltip.pos.y}
            className="max-w-md"
            {...tooltip.popupProps}
          >
            {label.length > 35 && <div className="text-foreground mb-1">{label}</div>}
            <TraceStepDetails
              step={line}
              label={traceMode === "BasicBlock" ? `Block #${line.index}:` : undefined}
            />
          </HoverPopupPanel>
        );
      })()}
    </div>
  );
});
