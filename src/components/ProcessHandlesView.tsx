import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Copy, KeyRound, RefreshCw, X, Eye, EyeOff, Crosshair } from "lucide-react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { DockPanel, PanelToolbar, PanelBody } from "./ui/panel";
import { EmptyState, LoadingState, ProcessUnavailableState } from "./ui/empty-state";
import { SortHeader } from "./ui/sort-header";
import { ResizableHeaderCell } from "./ui/resizable-header-cell";
import { ContextMenu, ContextMenuItem, ContextMenuSeparator } from "./ui/context-menu";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "./ui/dialog";
import { useContextMenu } from "@/hooks/useContextMenu";
import { useColumnWidths } from "@/hooks/useColumnWidths";
import { usePanelFocus } from "@/hooks/usePanelFocus";
import { cn } from "@/lib/utils";
import type { HandleInfo, PrivilegeInfo, ProcessObjects, TcpConnectionInfo, WindowInfo } from "@/hooks/useProcessObjects";

interface ProcessHandlesViewProps {
  objects: ProcessObjects | null;
  loading: boolean;
  /** True when a process is reachable (paused, running, or opened non-invasively). */
  canRefresh: boolean;
  hasSession: boolean;
  onRefresh: () => void;
  onCloseHandle: (handle: number) => void;
  onSetPrivilege: (name: string, enable: boolean) => void;
  onSetWindowEnabled: (hwnd: number, enabled: boolean) => void;
  onNavigateToDisassembly?: (address: string) => void;
}

/** Cell separator for the filter haystack; cannot occur in cell text. */
const SEP = String.fromCharCode(0);

const hex = (v: number, pad = 0) => `0x${v.toString(16).toUpperCase().padStart(pad, "0")}`;

// ── Generic sortable, filterable, resizable table ───────────────────────────

interface Column<T> {
  key: string;
  label: string;
  /** Fills the remaining width; not resizable. Exactly one column per section. */
  flex?: boolean;
  /** Default pixel width for fixed (non-flex) columns. */
  defaultWidth?: number;
  /** Text used for filtering and default (string) sort. */
  text: (row: T) => string;
  /** Numeric sort key when the column is a number/address. */
  num?: (row: T) => number;
  /** Custom cell content. `text` is the already-built `text(row)` string. */
  render?: (row: T, text: string) => React.ReactNode;
  className?: string;
}

interface SectionProps<T> {
  id: string;
  title: string;
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string;
  emptyText: string;
  onContextMenu?: (e: React.MouseEvent, row: T) => void;
  testId: string;
}

/**
 * One collapsible section of the Handles window: a header with the count and a
 * filter box, then a flexbox table whose fixed columns are drag-resizable
 * (persisted via `useColumnWidths`) and whose single flex column fills the rest.
 * Rows shrink to the panel width, so the view never scrolls horizontally — a
 * fixed column dragged wider just narrows the flex column.
 */
function Section<T>({ id, title, rows, columns, rowKey, emptyText, onContextMenu, testId }: SectionProps<T>) {
  const [open, setOpen] = useState(true);
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<{ key: string; asc: boolean } | null>(null);

  const defaults = useMemo(() => {
    const d: Record<string, number> = {};
    for (const c of columns) if (!c.flex) d[c.key] = c.defaultWidth ?? 100;
    return d;
  }, [columns]);
  const { columnWidths, handleColumnResizeStart } = useColumnWidths(`handles-cols-${id}`, defaults);

  // Every cell's text, built once per snapshot. Filtering and sorting then read
  // strings instead of rebuilding them (a `hex()` cell is three allocations),
  // and the row renderer reuses the same string for the cell and its tooltip.
  const cells = useMemo(
    () => rows.map((r) => columns.map((c) => c.text(r))),
    [rows, columns],
  );
  // One lowercased haystack per row, so a keystroke is one indexOf per row
  // rather than a lowercase of every cell of every row.
  const haystacks = useMemo(() => cells.map((row) => row.join(SEP).toLowerCase()), [cells]);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    let out = rows.map((row, i) => ({ row, cells: cells[i] }));
    if (q) out = out.filter((_, i) => haystacks[i].includes(q));
    if (sort) {
      const idx = columns.findIndex((c) => c.key === sort.key);
      const col = columns[idx];
      if (col) {
        const dir = sort.asc ? 1 : -1;
        // Decorate-sort: derive each key once, then compare with `<` — the data
        // is ASCII hex/identifiers, so `localeCompare` buys nothing.
        const keyed = out.map((e) => ({ e, k: col.num ? col.num(e.row) : e.cells[idx] }));
        keyed.sort((a, b) => (a.k < b.k ? -dir : a.k > b.k ? dir : 0));
        out = keyed.map((x) => x.e);
      }
    }
    return out;
  }, [rows, cells, haystacks, columns, filter, sort]);

  const toggleSort = (key: string) =>
    setSort((s) => (s?.key === key ? { key, asc: !s.asc } : { key, asc: true }));

  // Per-column class/style, resolved once per render instead of once per cell.
  const cellClass = useMemo(
    () => columns.map((c) => cn(c.flex ? "flex-1 min-w-0 truncate" : "shrink-0 truncate pr-1", c.className)),
    [columns],
  );
  const cellStyle = useMemo(
    () => columns.map((c) => (c.flex ? undefined : { width: columnWidths[c.key] })),
    [columns, columnWidths],
  );

  return (
    <div className="border-b border-border/60" data-testid={`${testId}-section`}>
      <div className="sticky top-0 z-10 flex items-center gap-2 px-2 py-1 bg-muted/95 border-b border-border/50 select-none">
        <span
          role="button"
          tabIndex={0}
          className="inline-flex items-center gap-1 text-xs font-medium cursor-pointer"
          onClick={() => setOpen((o) => !o)}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen((o) => !o); } }}
          data-testid={`${testId}-toggle`}
        >
          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          {title}
          <span className="text-muted-foreground font-normal">
            {filter.trim() ? `${visible.length} / ${rows.length}` : rows.length}
          </span>
        </span>
        <span className="flex-1" />
        <Input
          inputSize="xs"
          className="w-40 sm:w-56"
          placeholder={`Filter ${title.toLowerCase()}`}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          data-testid={`${testId}-filter`}
        />
      </div>
      {open && (
        <div className="text-xs font-mono" data-testid={`${testId}-table`}>
          <div className="flex gap-x-3 px-2 py-0.5 text-muted-foreground border-b border-border/50 select-none">
            {columns.map((c) =>
              c.flex ? (
                <span key={c.key} className="flex-1 min-w-0">
                  <SortHeader label={c.label} active={sort?.key === c.key} asc={sort?.asc ?? true} onClick={() => toggleSort(c.key)} />
                </span>
              ) : (
                <ResizableHeaderCell key={c.key} width={columnWidths[c.key]} onResizeStart={(e) => handleColumnResizeStart(c.key, e)}>
                  <SortHeader label={c.label} active={sort?.key === c.key} asc={sort?.asc ?? true} onClick={() => toggleSort(c.key)} />
                </ResizableHeaderCell>
              ),
            )}
          </div>
          {visible.length === 0 ? (
            <div className="px-2 py-2 text-muted-foreground font-sans">{rows.length === 0 ? emptyText : "No matches"}</div>
          ) : (
            visible.map(({ row, cells: text }) => (
              <div
                key={rowKey(row)}
                className="flex gap-x-3 px-2 py-0.5 border-b border-border/30 hover:bg-muted/30"
                onContextMenu={onContextMenu ? (e) => onContextMenu(e, row) : undefined}
                data-testid={`${testId}-row`}
              >
                {columns.map((c, i) => (
                  <span key={c.key} className={cellClass[i]} style={cellStyle[i]} title={text[i]}>
                    {c.render ? c.render(row, text[i]) : text[i]}
                  </span>
                ))}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ── The view ────────────────────────────────────────────────────────────────

type MenuTarget =
  | { kind: "handle"; row: HandleInfo }
  | { kind: "window"; row: WindowInfo }
  | { kind: "privilege"; row: PrivilegeInfo };

const PRIV_LABEL: Record<PrivilegeInfo["state"], string> = {
  Disabled: "Disabled",
  Enabled: "Enabled",
  EnabledByDefault: "Enabled (default)",
};

// Column definitions are compile-time constants — `hex`, `attrText`, `cn` and
// `PRIV_LABEL` are all module-level, so there is nothing to memoise per render.
const WINDOW_COLUMNS: Column<WindowInfo>[] = [
  { key: "handle", label: "Handle", defaultWidth: 84, text: (w) => hex(w.handle), num: (w) => w.handle },
  { key: "title", label: "Title", flex: true, text: (w) => w.title, className: "font-sans" },
  { key: "class", label: "Class", defaultWidth: 150, text: (w) => w.class_name, className: "font-sans" },
  { key: "thread", label: "Thread", defaultWidth: 64, text: (w) => String(w.thread_id), num: (w) => w.thread_id },
  { key: "enabled", label: "Enable", defaultWidth: 72, text: (w) => (w.enabled ? "Enabled" : "Disabled"),
    render: (w, text) => <span className={cn(!w.enabled && "text-muted-foreground")}>{text}</span> },
];

const HANDLE_COLUMNS: Column<HandleInfo>[] = [
  { key: "type", label: "Type", defaultWidth: 120, text: (h) => h.type_name || "?", className: "font-sans" },
  { key: "handle", label: "Handle", defaultWidth: 84, text: (h) => hex(h.handle), num: (h) => h.handle },
  { key: "access", label: "Access", defaultWidth: 96, text: (h) => hex(h.granted_access, 8), num: (h) => h.granted_access },
  { key: "attrs", label: "Attr", defaultWidth: 52, text: (h) => attrText(h.attributes), num: (h) => h.attributes },
  { key: "name", label: "Name", flex: true, text: (h) => h.name, className: "font-sans" },
];

const TCP_COLUMNS: Column<TcpConnectionInfo>[] = [
  { key: "remote", label: "Remote address", defaultWidth: 200, text: (c) => `${c.remote_address}:${c.remote_port}` },
  { key: "local", label: "Local address", flex: true, text: (c) => `${c.local_address}:${c.local_port}` },
  { key: "state", label: "State", defaultWidth: 130, text: (c) => c.state },
];

const PRIV_COLUMNS: Column<PrivilegeInfo>[] = [
  { key: "name", label: "Privilege", flex: true, text: (p) => p.name, className: "font-sans" },
  { key: "state", label: "State", defaultWidth: 150, text: (p) => PRIV_LABEL[p.state],
    render: (p, text) => <span className={cn(p.state === "Disabled" && "text-muted-foreground")}>{text}</span> },
];

/**
 * x64dbg-style Handles window: the target's windows, kernel handles, TCP
 * connections and token privileges, each in its own filterable section.
 * Columns are compact by default (fit the panel) and drag-resizable; the
 * per-window WndProc address lives in the row's context menu.
 */
export function ProcessHandlesView({
  objects, loading, canRefresh, hasSession, onRefresh,
  onCloseHandle, onSetPrivilege, onSetWindowEnabled, onNavigateToDisassembly,
}: ProcessHandlesViewProps) {
  const focusRef = usePanelFocus<HTMLButtonElement>("handles");
  const { contextMenu, openContextMenu, closeContextMenu } = useContextMenu<MenuTarget>();
  const [closePending, setClosePending] = useState<HandleInfo | null>(null);

  const body = () => {
    if (!hasSession) {
      return <EmptyState icon={<KeyRound className="h-12 w-12 mx-auto mb-4 opacity-50" />} title="No session" subtitle="Select a session to inspect its handles" />;
    }
    if (!canRefresh) {
      return <ProcessUnavailableState icon={KeyRound} what="Handles" />;
    }
    if (!objects) {
      return <LoadingState title="Enumerating handles..." />;
    }
    return (
      <>
        <Section id="windows" title="Windows" testId="handles-window" rows={objects.windows} columns={WINDOW_COLUMNS}
          rowKey={(w) => String(w.handle)} emptyText="The process owns no windows"
          onContextMenu={(e, row) => openContextMenu(e, { kind: "window", row })} />
        <Section id="handles" title="Handles" testId="handles-handle" rows={objects.handles} columns={HANDLE_COLUMNS}
          rowKey={(h) => String(h.handle)} emptyText="No handles"
          onContextMenu={(e, row) => openContextMenu(e, { kind: "handle", row })} />
        <Section id="tcp" title="TCP Connections" testId="handles-tcp" rows={objects.tcp_connections} columns={TCP_COLUMNS}
          rowKey={(c) => `${c.local_address}:${c.local_port}-${c.remote_address}:${c.remote_port}-${c.state}`}
          emptyText="No TCP connections" />
        <Section id="privileges" title="Privileges" testId="handles-privilege" rows={objects.privileges} columns={PRIV_COLUMNS}
          rowKey={(p) => p.name} emptyText="No privileges in the token"
          onContextMenu={(e, row) => openContextMenu(e, { kind: "privilege", row })} />
      </>
    );
  };

  return (
    <DockPanel>
      <PanelToolbar>
        <Button
          ref={focusRef}
          variant="outline"
          size="xs"
          onClick={onRefresh}
          disabled={!canRefresh || loading}
          title={canRefresh ? "Re-enumerate handles, windows, connections and privileges" : "Start or open a process first"}
          data-testid="handles-refresh"
        >
          <RefreshCw className={cn(loading && "animate-spin")} />
          Refresh
        </Button>
        {objects && (
          <span className="text-xs text-muted-foreground whitespace-nowrap truncate">
            {objects.windows.length}w · {objects.handles.length}h · {objects.tcp_connections.length} TCP · {objects.privileges.length} priv
          </span>
        )}
        <span className="flex-1" />
        {objects?.warnings.map((w) => (
          <Badge key={w} size="xs" variant="outline" className="text-destructive shrink-0" title={w}>
            {w.split(":")[0]} unavailable
          </Badge>
        ))}
      </PanelToolbar>
      <PanelBody>
        {body()}
      </PanelBody>

      {contextMenu && (() => {
        const target = contextMenu.data;
        return (
          <ContextMenu x={contextMenu.x} y={contextMenu.y} onClose={closeContextMenu}>
            {target.kind === "handle" && (
              <>
                <ContextMenuItem icon={<Copy />} onClick={() => navigator.clipboard.writeText(target.row.name || hex(target.row.handle))}>
                  Copy {target.row.name ? "name" : "handle"}
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem destructive icon={<X />} onClick={() => setClosePending(target.row)}>
                  Close handle {hex(target.row.handle)}
                </ContextMenuItem>
              </>
            )}
            {target.kind === "window" && (
              <>
                {target.row.wnd_proc !== 0 && onNavigateToDisassembly && (
                  <ContextMenuItem icon={<Crosshair />} onClick={() => onNavigateToDisassembly(hex(target.row.wnd_proc))}>
                    Follow WndProc ({hex(target.row.wnd_proc)}) in disassembler
                  </ContextMenuItem>
                )}
                <ContextMenuItem icon={<Copy />} onClick={() => navigator.clipboard.writeText(target.row.title || target.row.class_name)}>
                  Copy title
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem icon={target.row.enabled ? <EyeOff /> : <Eye />} onClick={() => onSetWindowEnabled(target.row.handle, !target.row.enabled)}>
                  {target.row.enabled ? "Disable window" : "Enable window"}
                </ContextMenuItem>
              </>
            )}
            {target.kind === "privilege" && (
              <ContextMenuItem
                icon={<KeyRound />}
                onClick={() => onSetPrivilege(target.row.name, target.row.state === "Disabled")}
                data-testid="handles-privilege-menu-toggle"
              >
                {target.row.state === "Disabled" ? "Enable" : "Disable"} {target.row.name}
              </ContextMenuItem>
            )}
          </ContextMenu>
        );
      })()}

      <Dialog open={closePending !== null} onOpenChange={(o) => !o && setClosePending(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Close handle {closePending ? hex(closePending.handle) : ""}?</DialogTitle>
            <DialogDescription>
              The {closePending?.type_name || "object"} handle{closePending?.name ? ` "${closePending.name}"` : ""} is
              closed inside the target. Code still using it will fail with an invalid-handle error,
              or worse, touch whatever object later reuses the value. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setClosePending(null)}>Cancel</Button>
            <Button
              variant="destructive"
              data-testid="handles-close-confirm"
              onClick={() => { if (closePending) onCloseHandle(closePending.handle); setClosePending(null); }}
            >
              Close handle
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DockPanel>
  );
}

/** `OBJ_PROTECT_CLOSE` (0x1) / `OBJ_INHERIT` (0x2) as letters, "-" when neither. */
function attrText(attributes: number): string {
  const parts: string[] = [];
  if (attributes & 0x1) parts.push("P");
  if (attributes & 0x2) parts.push("I");
  return parts.length ? parts.join("") : "-";
}
