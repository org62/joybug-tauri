import { useState, useCallback } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Checkbox } from "./ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { X, Bookmark as BookmarkIcon, Lock, Unlock } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ResolvedBookmark } from "@/hooks/useBookmarks";
import { useContextMenu } from "@/hooks/useContextMenu";
import { useColumnWidths } from "@/hooks/useColumnWidths";
import { GroupedItemList } from "./GroupedItemList";
import { DockPanel, PanelToolbar } from "./ui/panel";
import { ContextMenu, ContextMenuItem, ContextMenuSeparator } from "./ui/context-menu";

const VALUE_TYPES = ["U8", "U16", "U32", "U64", "F32", "F64"];

type BookmarkRow = ResolvedBookmark & { enabled: boolean };

type ColKey = "name" | "address" | "type" | "value";
const DEFAULT_WIDTHS: Record<ColKey, number> = { name: 120, address: 150, type: 72, value: 170 };
const COLUMN_WIDTHS_KEY = "bookmarks.columnWidths";

interface BookmarksViewProps {
  bookmarks: ResolvedBookmark[];
  onRemoveBookmark?: (id: string) => void;
  onRemoveBookmarks?: (ids: string[]) => void;
  onUpdateBookmark?: (id: string, fields: { name?: string | null; comment?: string | null; group?: string | null; valueType?: string | null }) => void;
  onSetValue?: (id: string, value: string) => void;
  onToggleLock?: (id: string, locked: boolean) => void;
  onNavigateToDisassembly?: (address: string) => void;
  onNavigateToMemory?: (address: string) => void;
}

/** Strip the " (0x..)" suffix the backend adds to integer displays, for editing. */
function plainValue(display: string | null): string {
  if (!display) return "";
  const idx = display.indexOf(" (0x");
  return idx >= 0 ? display.slice(0, idx) : display;
}

function formatChain(b: ResolvedBookmark): string {
  const base = b.base_symbol ?? (b.module_name ? `${b.module_name}+0x${(b.module_offset ?? 0).toString(16)}` : b.resolved_address);
  const offs = (b.pointer_offsets ?? []).map((o) => `+0x${o.toString(16)}`).join(" → ");
  return offs ? `${base} → ${offs} ⇒ ${b.resolved_address}` : `${base} ⇒ ${b.resolved_address}`;
}

export function BookmarksView({
  bookmarks,
  onRemoveBookmark,
  onRemoveBookmarks,
  onUpdateBookmark,
  onSetValue,
  onToggleLock,
  onNavigateToDisassembly,
  onNavigateToMemory,
}: BookmarksViewProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<{ id: string; field: "name" | "value"; draft: string } | null>(null);
  const { columnWidths, handleColumnResizeStart } = useColumnWidths<ColKey>(COLUMN_WIDTHS_KEY, DEFAULT_WIDTHS);

  const { contextMenu, openContextMenu, closeContextMenu } = useContextMenu<{ id: string }>();

  const rows: BookmarkRow[] = bookmarks.map((b) => ({ ...b, enabled: b.locked }));

  // Merge partial changes with the bookmark's current fields so an update never
  // wipes name/comment/group (the backend overwrites name/comment unconditionally).
  const update = useCallback((id: string, changes: { name?: string | null; comment?: string | null; group?: string | null; valueType?: string | null }) => {
    const bm = bookmarks.find((b) => b.id === id);
    if (!bm) return;
    onUpdateBookmark?.(id, {
      name: changes.name !== undefined ? changes.name : bm.name,
      comment: changes.comment !== undefined ? changes.comment : bm.comment,
      group: changes.group !== undefined ? changes.group : bm.group,
      valueType: changes.valueType, // undefined => backend leaves value_type unchanged
    });
  }, [bookmarks, onUpdateBookmark]);

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    setSelectedIds((prev) => (prev.size === bookmarks.length ? new Set() : new Set(bookmarks.map((b) => b.id))));
  }, [bookmarks]);

  const handleRemoveSelected = useCallback(() => {
    if (selectedIds.size === 0 || !onRemoveBookmarks) return;
    onRemoveBookmarks(Array.from(selectedIds));
    setSelectedIds(new Set());
  }, [selectedIds, onRemoveBookmarks]);

  const generateNewGroupName = useCallback(() => {
    let name = "New Group";
    let counter = 2;
    const existing = new Set(bookmarks.map((b) => b.group).filter(Boolean));
    while (existing.has(name)) { name = `New Group ${counter}`; counter++; }
    return name;
  }, [bookmarks]);

  const commitEdit = useCallback(() => {
    if (!editing) return;
    const bm = bookmarks.find((b) => b.id === editing.id);
    if (bm) {
      if (editing.field === "name") {
        update(bm.id, { name: editing.draft.trim() || null });
      } else {
        if (editing.draft.trim()) onSetValue?.(bm.id, editing.draft.trim());
      }
    }
    setEditing(null);
  }, [editing, bookmarks, update, onSetValue]);

  const navigate = useCallback((b: ResolvedBookmark) => {
    if (!b.is_resolved) return;
    if (b.kind === "code") onNavigateToDisassembly?.(b.resolved_address);
    else onNavigateToMemory?.(b.resolved_address);
  }, [onNavigateToDisassembly, onNavigateToMemory]);

  const allSelected = bookmarks.length > 0 && selectedIds.size === bookmarks.length;

  const renderRow = (b: BookmarkRow, isDragOverlay?: boolean) => (
    <div
      className={cn(
        "flex items-center px-2 py-1 text-xs font-mono hover:bg-muted/30 group",
        selectedIds.has(b.id) && "bg-accent/30",
        !b.is_resolved && "opacity-50",
        isDragOverlay && "bg-popover border rounded shadow-md",
      )}
      onContextMenu={(e) => { if (!isDragOverlay) openContextMenu(e, { id: b.id }); }}
    >
      <span className="w-6 shrink-0 flex items-center justify-center">
        <Checkbox
          checked={selectedIds.has(b.id)}
          onChange={() => toggleSelect(b.id)}
        />
      </span>

      {/* Name (editable) */}
      <span className="shrink-0 truncate" style={{ width: columnWidths.name }}>
        {editing?.id === b.id && editing.field === "name" ? (
          <Input
            autoFocus
            value={editing.draft}
            onChange={(e) => setEditing({ ...editing, draft: e.target.value })}
            onBlur={commitEdit}
            onKeyDown={(e) => { if (e.key === "Enter") commitEdit(); if (e.key === "Escape") setEditing(null); }}
            inputSize="xs"
          />
        ) : (
          <span
            className="cursor-text hover:underline"
            title="Click to rename"
            onClick={() => setEditing({ id: b.id, field: "name", draft: b.name ?? "" })}
          >
            {b.name || <span className="text-muted-foreground/60">unnamed</span>}
          </span>
        )}
      </span>

      {/* Address (navigate) */}
      <span
        className="shrink-0 text-blue-400 cursor-pointer hover:underline truncate"
        style={{ width: columnWidths.address }}
        title={b.resolved_address}
        onClick={() => navigate(b)}
      >
        {b.resolved_address || "—"}
      </span>

      {/* Type */}
      <span className="shrink-0 pr-1" style={{ width: columnWidths.type }}>
        {b.kind === "code" ? (
          <span className="text-muted-foreground">code</span>
        ) : (
          <Select value={b.value_type ?? "U32"} onValueChange={(v) => update(b.id, { valueType: v })}>
            <SelectTrigger size="xs" className="w-full gap-1 px-2">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {VALUE_TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
            </SelectContent>
          </Select>
        )}
      </span>

      {/* Value (editable for value/pointer) */}
      <span className="shrink-0 truncate" style={{ width: columnWidths.value }}>
        {b.kind === "code" ? (
          <span className="text-muted-foreground/60">—</span>
        ) : editing?.id === b.id && editing.field === "value" ? (
          <Input
            autoFocus
            value={editing.draft}
            onChange={(e) => setEditing({ ...editing, draft: e.target.value })}
            onBlur={commitEdit}
            onKeyDown={(e) => { if (e.key === "Enter") commitEdit(); if (e.key === "Escape") setEditing(null); }}
            inputSize="xs"
          />
        ) : (
          <span
            className="cursor-text hover:underline text-green-500"
            title="Click to edit value"
            onClick={() => setEditing({ id: b.id, field: "value", draft: plainValue(b.current_value) })}
          >
            {b.current_value ?? "??"}
          </span>
        )}
      </span>

      {/* Lock */}
      <span className="w-8 shrink-0 flex items-center justify-center">
        {b.kind !== "code" && (
          <Button
            variant="ghost"
            size="icon-xs"
            className={cn(b.locked ? "text-amber-500" : "text-muted-foreground")}
            onClick={() => onToggleLock?.(b.id, !b.locked)}
            title={b.locked ? "Unlock value" : "Lock (freeze) value"}
          >
            {b.locked ? <Lock /> : <Unlock />}
          </Button>
        )}
      </span>

      {/* Detail: pointer chain or asm + comment */}
      <span className="flex-1 min-w-0 truncate text-muted-foreground" title={b.kind === "code" ? `${b.asm_text ?? ""}${b.comment ? `  ; ${b.comment}` : ""}` : formatChain(b)}>
        {b.kind === "pointer" && formatChain(b)}
        {b.kind === "code" && (
          <>
            <span>{b.asm_text}</span>
            {b.comment && <span className="text-amber-600/80 ml-2">; {b.comment}</span>}
          </>
        )}
        {b.kind === "value" && b.comment && <span className="text-amber-600/80">; {b.comment}</span>}
      </span>

      {!isDragOverlay && (
        <span className="w-8 shrink-0 flex items-center justify-center">
          <Button
            variant="ghost"
            size="icon-xs"
            className="opacity-0 group-hover:opacity-100 transition-opacity"
            onClick={() => onRemoveBookmark?.(b.id)}
            title="Remove bookmark"
          >
            <X />
          </Button>
        </span>
      )}
    </div>
  );

  return (
    <DockPanel>
      <GroupedItemList
        items={rows}
        onUpdateItemGroup={(id, group) => update(id, { group: group ?? null })}
        onEnableGroup={(group, enabled) => {
          bookmarks.filter((b) => b.group === group && b.kind !== "code").forEach((b) => onToggleLock?.(b.id, enabled));
        }}
        onDeleteGroup={(ids) => onRemoveBookmarks?.(ids)}
        renderItem={renderRow}
        groupDotColor="blue"
        renderToolbar={() => (
          <>
            <PanelToolbar>
              <Button
                variant="outline"
                size="xs"
                disabled={selectedIds.size === 0}
                onClick={handleRemoveSelected}
              >
                Remove Selected ({selectedIds.size})
              </Button>
              <div className="flex-1" />
              <span className="text-xs text-muted-foreground">{bookmarks.length} bookmark{bookmarks.length !== 1 ? "s" : ""}</span>
            </PanelToolbar>
            {bookmarks.length > 0 && (
              <div className="flex items-center px-2 py-1 border-b border-border text-xs text-muted-foreground font-medium shrink-0">
                <span className="w-6 shrink-0 flex items-center justify-center">
                  <Checkbox checked={allSelected} onChange={toggleSelectAll} />
                </span>
                <span className="shrink-0 truncate relative pr-1" style={{ width: columnWidths.name }}>
                  Name
                  <div className="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-blue-500/40 active:bg-blue-500/60" onMouseDown={(e) => handleColumnResizeStart("name", e)} />
                </span>
                <span className="shrink-0 truncate relative pr-1" style={{ width: columnWidths.address }}>
                  Address
                  <div className="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-blue-500/40 active:bg-blue-500/60" onMouseDown={(e) => handleColumnResizeStart("address", e)} />
                </span>
                <span className="shrink-0 truncate relative pr-1" style={{ width: columnWidths.type }}>
                  Type
                  <div className="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-blue-500/40 active:bg-blue-500/60" onMouseDown={(e) => handleColumnResizeStart("type", e)} />
                </span>
                <span className="shrink-0 truncate relative pr-1" style={{ width: columnWidths.value }}>
                  Value
                  <div className="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-blue-500/40 active:bg-blue-500/60" onMouseDown={(e) => handleColumnResizeStart("value", e)} />
                </span>
                <span className="w-8 shrink-0 text-center">Lock</span>
                <span className="flex-1 min-w-0">Details</span>
                <span className="w-8 shrink-0" />
              </div>
            )}
          </>
        )}
        renderEmptyState={() => (
          <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground p-4">
            <BookmarkIcon className="h-12 w-12 mx-auto mb-4 opacity-50" />
            <p className="text-base font-medium">No bookmarks</p>
            <p className="text-sm mt-1">Right-click an address in memory, a scan/search result, a pointer-scan path, or a disassembly line and choose "Add to Bookmarks".</p>
          </div>
        )}
      />

      {contextMenu && (() => {
        const b = bookmarks.find((x) => x.id === contextMenu.data.id);
        if (!b) return null;
        return (
          <ContextMenu x={contextMenu.x} y={contextMenu.y} onClose={closeContextMenu}>
            {b.kind !== "code" && (
              <ContextMenuItem onClick={() => onToggleLock?.(b.id, !b.locked)}>
                {b.locked ? "Unlock value" : "Lock (freeze) value"}
              </ContextMenuItem>
            )}
            <ContextMenuItem onClick={() => update(b.id, { group: generateNewGroupName() })}>
              Set Group
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem destructive onClick={() => onRemoveBookmark?.(contextMenu.data.id)}>
              Remove Bookmark
            </ContextMenuItem>
          </ContextMenu>
        );
      })()}
    </DockPanel>
  );
}
