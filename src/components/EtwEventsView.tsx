import { useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { Activity, Layers, Monitor, Trash2, X } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { VirtualizedList } from "./ui/virtualized-list";
import { DockPanel, PanelToolbar } from "./ui/panel";
import { ScrollArea } from "./ui/scroll-area";
import { EmptyState } from "./ui/empty-state";
import { ContextMenu, ContextMenuItem, ContextMenuSeparator } from "./ui/context-menu";
import { useContextMenu } from "@/hooks/useContextMenu";
import { copyToClipboard } from "@/lib/clipboard";
import { useEtwEvents, type EtwEvent } from "@/hooks/useEtwEvents";
import { useResizablePaneHeight } from "@/hooks/useResizablePaneHeight";

const ROW_HEIGHT = 22;

/** A frame that never symbolized — a bare `0x…` return address. */
const isRawFrame = (f: string) => /^0x[0-9a-fA-F]+$/.test(f.trim());

const KINDS = ["process", "file", "registry", "network", "audit"] as const;
type Kind = (typeof KINDS)[number];

// Per-kind dot/text tone, from the semantic syn-* palette (one meaning each).
const KIND_TONE: Record<string, string> = {
  process: "text-syn-state",
  file: "text-syn-link",
  registry: "text-syn-patched",
  network: "text-syn-flow",
  audit: "text-syn-changed",
  tracer: "text-destructive",
};

/** Best detail string for a row: path, else dest, else image.
 *
 * Audit rows carry none of those — their content is "who was acted on, with
 * what rights" — so they get their own rendering. A non-zero status means the
 * call was refused, which is worth showing rather than hiding. */
function detailOf(e: EtwEvent): string {
  if (e.kind === "audit") {
    const target = e.target_pid != null ? `pid ${e.target_pid}` : "?";
    const self = e.target_pid != null && e.target_pid === e.pid ? " (self)" : "";
    const denied = e.status ? ` failed 0x${(e.status >>> 0).toString(16)}` : "";
    return `\u2192 ${target}${self}  ${e.access ?? ""}${denied}`;
  }
  return e.path ?? e.dest ?? e.image ?? "";
}

interface EtwEventsViewProps {
  sessionId: string | undefined;
  /** Session run still alive (running/paused/provisioning) — gates the poll interval. */
  live: boolean;
  isSandbox: boolean;
  /** ETW is being collected for this session (sandbox collect-ETW or host ETW). */
  active: boolean;
  /** Live process id; a change to a new pid (restart) clears the log. */
  processId?: number;
}

export function EtwEventsView({ sessionId, isSandbox, active, processId, live }: EtwEventsViewProps) {
  const { events, clear } = useEtwEvents(sessionId, active, processId, live);
  const [enabledKinds, setEnabledKinds] = useState<Set<string>>(new Set(KINDS));
  const [search, setSearch] = useState("");
  const { contextMenu, openContextMenu, closeContextMenu } = useContextMenu<EtwEvent>();
  // Callstack detail: the selected event + its (symbolized) frames.
  const [selected, setSelected] = useState<EtwEvent | null>(null);
  const [frames, setFrames] = useState<string[] | null>(null);
  const [framesLoading, setFramesLoading] = useState(false);
  // Resizable callstack detail pane (persisted). Reserve room for the toolbar
  // + a usable slice of the list above.
  const {
    height: detailHeight,
    handleResizeStart,
    ref: detailRef,
  } = useResizablePaneHeight({
    storageKey: "etw-callstack-detail-height",
    defaultHeight: 240,
    minHeight: 80,
    reserve: 120,
  });
  // Invalidates stale resolves (row switch / close) so a late retry can't clobber.
  const reqRef = useRef(0);

  const closeStack = () => {
    reqRef.current++;
    setSelected(null);
    setFrames(null);
  };

  const openStack = async (e: EtwEvent) => {
    if (!e.stack || e.stack.length === 0 || !sessionId) return;
    const token = ++reqRef.current;
    const stack = e.stack;
    setSelected(e);
    setFrames(null);
    setFramesLoading(true);
    const resolve = () =>
      invoke<string[]>("resolve_etw_stack", { sessionId, pid: e.pid ?? 0, addresses: stack });
    try {
      const f = await resolve();
      if (reqRef.current !== token) return;
      setFrames(f);
      // Symbols load asynchronously: modules still pending come back as raw
      // `0x…` addresses. Re-resolve once shortly after so they fill in.
      if (f.some(isRawFrame)) {
        window.setTimeout(() => {
          if (reqRef.current !== token) return;
          resolve()
            .then((f2) => {
              if (reqRef.current === token) setFrames(f2);
            })
            .catch(() => {
              /* keep the first result */
            });
        }, 800);
      }
    } catch {
      if (reqRef.current === token) setFrames(stack); // fall back to raw addresses
    } finally {
      if (reqRef.current === token) setFramesLoading(false);
    }
  };

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    // Fast path: nothing filtered out. This memo re-runs on every poll tick
    // (the events array is new each time), so don't lowercase 4 fields × up to
    // 100k rows just to keep them all.
    if (!q && enabledKinds.size === KINDS.length) return events;
    return events.filter((e) => {
      if (!enabledKinds.has(e.kind)) return false;
      if (!q) return true;
      return (
        (e.path ?? "").toLowerCase().includes(q) ||
        (e.image ?? "").toLowerCase().includes(q) ||
        (e.dest ?? "").toLowerCase().includes(q) ||
        (e.access ?? "").toLowerCase().includes(q) ||
        e.op.toLowerCase().includes(q) ||
        String(e.pid ?? "").includes(q) ||
        String(e.target_pid ?? "").includes(q)
      );
    });
  }, [events, enabledKinds, search]);

  // Newest first — one backwards copy, not filter+slice+reverse.
  const rows = useMemo(() => {
    const out = new Array<EtwEvent>(filtered.length);
    for (let i = 0; i < filtered.length; i++) out[i] = filtered[filtered.length - 1 - i];
    return out;
  }, [filtered]);

  const toggleKind = (k: Kind) => {
    setEnabledKinds((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  };

  const copy = (text: string | null, label: string) => {
    if (text) void copyToClipboard(text, label);
  };

  // Empty state: ETW isn't being collected for this session.
  if (!active) {
    return (
      <DockPanel>
        <EmptyState
          icon={<Activity className="size-5" />}
          title="ETW collection is off for this session"
          subtitle="Enable ETW collection in the session's Edit dialog (Windows Sandbox, or a host session)."
        />
      </DockPanel>
    );
  }

  return (
    <DockPanel>
      <PanelToolbar>
        <Activity className="size-3.5 text-syn-state shrink-0" />
        {KINDS.map((k) => {
          const on = enabledKinds.has(k);
          return (
            <Button
              key={k}
              size="xs"
              variant={on ? "secondary" : "ghost"}
              onClick={() => toggleKind(k)}
              className="capitalize"
            >
              <span className={`mr-1 ${on ? KIND_TONE[k] : "text-muted-foreground/40"}`}>●</span>
              {k}
            </Button>
          );
        })}
        <Input
          inputSize="xs"
          placeholder="Search…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-48 ml-1"
        />
        <span className="text-xs text-muted-foreground ml-auto tabular-nums">
          Showing {filtered.length.toLocaleString()} of {events.length.toLocaleString()}
        </span>
        {isSandbox && (
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              if (!sessionId) return;
              void invoke("open_sandbox_view", { sessionId }).catch((e) =>
                toast.error(`Could not open sandbox view: ${e}`),
              );
            }}
            title="Open the interactive Windows Sandbox window"
          >
            <Monitor className="size-3.5 mr-1" />
            View Sandbox
          </Button>
        )}
        <Button size="icon-xs" variant="ghost" onClick={clear} title="Clear events">
          <Trash2 className="size-3.5" />
        </Button>
      </PanelToolbar>

      {events.length === 0 ? (
        <div className="flex-1 min-h-0 flex items-center justify-center text-center text-xs text-muted-foreground px-6">
          Waiting for ETW events…
        </div>
      ) : (
        <VirtualizedList
          className="flex-1 min-h-0"
          items={rows}
          rowHeight={ROW_HEIGHT}
          getItemKey={(e) => e.seq}
          renderItem={(e) => {
            const size = e.size != null ? ` (${e.size} B)` : "";
            const exit = e.exit != null ? ` exit=${e.exit}` : "";
            return (
              <div
                data-testid="etw-row"
                data-kind={e.kind}
                onContextMenu={(ev) => openContextMenu(ev, e)}
                onClick={() => e.stack && openStack(e)}
                className={`flex items-center gap-2 px-2 border-b border-border/50 hover:bg-muted/40 h-full font-mono text-xs leading-none ${
                  e.stack ? "cursor-pointer" : ""
                } ${selected?.seq === e.seq ? "bg-muted/60" : ""}`}
              >
                <span className="text-muted-foreground shrink-0 tabular-nums" title={e.time}>
                  {e.time}
                </span>
                <span className={`w-16 shrink-0 uppercase ${KIND_TONE[e.kind] ?? "text-muted-foreground"}`}>
                  {e.kind}
                </span>
                <span className="w-20 shrink-0 text-muted-foreground">{e.op}</span>
                <span className="w-14 shrink-0 text-right tabular-nums text-muted-foreground">
                  {e.pid ?? ""}
                </span>
                <span className="min-w-0 flex-1 truncate" title={detailOf(e)}>
                  {detailOf(e)}
                  {size}
                  {exit}
                </span>
                {e.stack && e.stack.length > 0 && (
                  <span className="shrink-0 text-muted-foreground" title={`${e.stack.length}-frame callstack`}>
                    <Layers className="size-3" />
                  </span>
                )}
              </div>
            );
          }}
        />
      )}

      {selected && (
        <div
          ref={detailRef}
          className="shrink-0 border-t bg-muted/20 flex flex-col"
          style={{ height: detailHeight }}
        >
          {/* Drag handle — resize the detail pane (drag up to grow). */}
          <div
            className="h-1 shrink-0 cursor-row-resize hover:bg-ring/40 active:bg-ring/60 transition-colors"
            onMouseDown={handleResizeStart}
          />
          <div className="flex items-center gap-2 px-2 py-1 text-xs border-b select-none">
            <Layers className="size-3.5 text-muted-foreground" />
            <span className="font-medium">Callstack</span>
            <span className="text-muted-foreground truncate">
              {selected.kind}/{selected.op} · pid {selected.pid ?? "?"}
            </span>
            <Button
              size="icon-xs"
              variant="ghost"
              className="ml-auto"
              onClick={closeStack}
              title="Close"
            >
              <X className="size-3.5" />
            </Button>
          </div>
          <ScrollArea className="flex-1 min-h-0 font-mono text-xs px-2 py-1">
            {framesLoading ? (
              <div className="text-muted-foreground">Resolving symbols…</div>
            ) : (
              (frames ?? selected.stack ?? []).map((f, i) => (
                <div
                  key={i}
                  className={`whitespace-nowrap leading-tight ${isRawFrame(f) ? "text-muted-foreground" : ""}`}
                  title={isRawFrame(f) ? "No symbols for this address" : undefined}
                >
                  <span className="text-muted-foreground mr-2 tabular-nums">{i}</span>
                  {f}
                </div>
              ))
            )}
          </ScrollArea>
        </div>
      )}

      {contextMenu && (
        <ContextMenu x={contextMenu.x} y={contextMenu.y} onClose={closeContextMenu} className="min-w-[180px]">
          {contextMenu.data.path && (
            <ContextMenuItem onClick={() => copy(contextMenu.data.path, "path")}>Copy path</ContextMenuItem>
          )}
          {contextMenu.data.dest && (
            <ContextMenuItem onClick={() => copy(contextMenu.data.dest, "destination")}>Copy destination</ContextMenuItem>
          )}
          {contextMenu.data.image && (
            <ContextMenuItem onClick={() => copy(contextMenu.data.image, "image path")}>Copy image path</ContextMenuItem>
          )}
          <ContextMenuItem onClick={() => copy(JSON.stringify(contextMenu.data), "row JSON")}>
            Copy row as JSON
          </ContextMenuItem>
          <ContextMenuSeparator />
          {contextMenu.data.pid != null && (
            <ContextMenuItem onClick={() => setSearch(String(contextMenu.data.pid))}>
              Filter to PID {contextMenu.data.pid}
            </ContextMenuItem>
          )}
          {contextMenu.data.target_pid != null
            && contextMenu.data.target_pid !== contextMenu.data.pid && (
            <ContextMenuItem onClick={() => setSearch(String(contextMenu.data.target_pid))}>
              Filter to target PID {contextMenu.data.target_pid}
            </ContextMenuItem>
          )}
          <ContextMenuItem onClick={() => setEnabledKinds(new Set([contextMenu.data.kind]))}>
            Only {contextMenu.data.kind} events
          </ContextMenuItem>
        </ContextMenu>
      )}
    </DockPanel>
  );
}
