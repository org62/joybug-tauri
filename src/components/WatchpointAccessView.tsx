import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Square, Trash2, Fingerprint } from "lucide-react";
import { cn, LINK_VALUE_CLASS } from "@/lib/utils";
import { DockPanel, PanelToolbar, PanelBody } from "./ui/panel";
import { EmptyState } from "./ui/empty-state";
import { TruncatedSymbol } from "./ui/truncated-symbol";
import type { WatchpointTrace } from "@/hooks/useWatchpointTrace";

interface WatchpointAccessViewProps {
  traces: WatchpointTrace[];
  onStopTrace: (breakpointId: string) => void;
  onClearRows: (address: string) => void;
  onNavigateToDisassembly?: (address: string) => void;
}

/** Human label for a watchpoint's access mode. */
function modeLabel(hwType: string, hwSize: number): string {
  const t = hwType === "ReadWrite" ? "read/write" : hwType === "Write" ? "write" : hwType.toLowerCase();
  return `${t} · ${hwSize}B`;
}

export function WatchpointAccessView({
  traces,
  onStopTrace,
  onClearRows,
  onNavigateToDisassembly,
}: WatchpointAccessViewProps) {
  const totalAccessors = traces.reduce((n, t) => n + t.rows.length, 0);

  return (
    <DockPanel>
      <PanelToolbar>
        <Fingerprint className="size-3.5 text-syn-patched shrink-0" />
        <span className="text-xs text-muted-foreground">
          {traces.length === 0
            ? "No access traces"
            : `${totalAccessors} accessor${totalAccessors === 1 ? "" : "s"} · ${traces.length} trace${traces.length === 1 ? "" : "s"}`}
        </span>
      </PanelToolbar>

      <PanelBody>
        {traces.length === 0 ? (
          <EmptyState
            icon={<Fingerprint className="h-10 w-10 mx-auto mb-3 opacity-40" />}
            title="No access trace running"
            subtitle={<>Right-click an address in Memory or a Bookmark → <em>Find what writes / accesses this address</em>, then run the target.</>}
          />
        ) : (
          traces.map((trace) => (
            <div key={trace.breakpointId} className="border-b border-border/60 last:border-b-0">
              {/* Trace section header */}
              <div className="flex items-center gap-2 px-2 py-1 bg-muted/30 sticky top-0 z-10">
                <span
                  className={cn("h-2.5 w-2.5 rounded-full shrink-0", trace.tracing ? "bg-syn-patched animate-pulse" : "bg-muted-foreground/40")}
                  title={trace.tracing ? "Collecting" : "Stopped"}
                />
                <span className="font-mono text-xs">{trace.address}</span>
                <Badge size="xs" className="bg-syn-patched/15 text-syn-patched text-[10px] shrink-0">
                  {modeLabel(trace.hwType, trace.hwSize)}
                </Badge>
                {trace.symbol && (
                  <span className="text-[11px] text-muted-foreground truncate max-w-[40%]" title={trace.symbol}>
                    {trace.symbol}
                  </span>
                )}
                <span className="flex-1" />
                {trace.tracing && (
                  <Button
                    variant="ghost"
                    size="xs"
                    className="text-muted-foreground hover:text-foreground"
                    onClick={() => onStopTrace(trace.breakpointId)}
                    title="Stop collecting (keeps results)"
                  >
                    <Square /> Stop
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => onClearRows(trace.address)}
                  title="Clear collected accessors"
                >
                  <Trash2 />
                </Button>
              </div>

              {/* Accessor rows */}
              {trace.rows.length === 0 ? (
                <div className="px-3 py-2 text-xs text-muted-foreground italic">
                  {trace.tracing ? "Waiting for accesses… run the target." : "No accesses recorded."}
                </div>
              ) : (
                trace.rows.map((row) => (
                  <div
                    key={row.raw_rip}
                    className="flex items-center gap-2 px-2 py-1 text-xs font-mono hover:bg-muted/50 group"
                  >
                    <span
                      className={cn(
                        "shrink-0 w-[132px] truncate",
                        onNavigateToDisassembly ? LINK_VALUE_CLASS : "text-muted-foreground",
                      )}
                      title={`${row.accessor}${row.raw_rip !== row.accessor ? ` (trap @ ${row.raw_rip})` : ""}`}
                      onClick={() => onNavigateToDisassembly?.(row.accessor)}
                    >
                      {row.accessor}
                    </span>
                    <Badge size="xs" className="bg-muted text-muted-foreground text-[10px] shrink-0 tabular-nums" title={`${row.hit_count} hits`}>
                      ×{row.hit_count}
                    </Badge>
                    <span className="flex-1 min-w-0 truncate text-foreground/90" title={row.disasm ?? undefined}>
                      {row.disasm ?? <span className="text-muted-foreground/50 italic">—</span>}
                    </span>
                    {row.symbol && (
                      <TruncatedSymbol text={row.symbol} className="shrink-0 max-w-[38%] text-muted-foreground" />
                    )}
                    {row.thread_ids.length > 0 && (
                      <span className="shrink-0 text-[10px] text-muted-foreground/70" title="Thread id(s)">
                        t{row.thread_ids.join(",")}
                      </span>
                    )}
                  </div>
                ))
              )}
            </div>
          ))
        )}
      </PanelBody>
    </DockPanel>
  );
}
