import { useState, useCallback } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { InlineEditInput } from "./ui/inline-edit-input";
import { ResizableHeaderCell } from "./ui/resizable-header-cell";
import { Badge } from "./ui/badge";
import { Trash2, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { Breakpoint } from "@/hooks/useBreakpoints";
import { useContextMenu } from "@/hooks/useContextMenu";
import { useColumnWidths } from "@/hooks/useColumnWidths";
import { RegisterContext, SymbolResolver, sanitizeAddressInput, parseAddressExpression } from "@/lib/hexUtils";
import { GroupedItemList } from "./GroupedItemList";
import { DockPanel, PanelToolbar } from "./ui/panel";
import { ContextMenu, ContextMenuItem, ContextMenuSeparator } from "./ui/context-menu";
import { TruncatedSymbol } from "./ui/truncated-symbol";

type ColKey = "name" | "address";
const DEFAULT_WIDTHS: Record<ColKey, number> = { name: 120, address: 150 };
const COLUMN_WIDTHS_KEY = "breakpoints.columnWidths";
/** Fixed row chrome: dot (24) + delete (32) + row px-2 (16) + min flex-1 symbol (152). */
const FIXED_COLS_PX = 24 + 32 + 16 + 152;

interface BreakpointsViewProps {
  breakpoints: Breakpoint[];
  onToggleBreakpoint: (address: string) => void;
  onRemoveBreakpoint: (id: string) => void;
  onRemoveBreakpoints: (ids: string[]) => void;
  onEnableBreakpoint: (id: string, enabled: boolean) => void;
  onEnableBreakpointGroup: (group: string, enabled: boolean) => void;
  onUpdateBreakpoint: (id: string, name?: string, group?: string) => void;
  onNavigateToDisassembly?: (address: string) => void;
  registers?: RegisterContext;
  resolveSymbol?: SymbolResolver;
}

/** Breakpoint dot color depends on bp_kind: red for software, amber/orange for hardware */
function BreakpointDot({ enabled, isActive, isHardware, onClick }: { enabled: boolean; isActive: boolean; isHardware: boolean; onClick: () => void }) {
  const activeColor = isHardware ? "bg-amber-500" : "bg-red-500";
  const pendingColor = isHardware ? "border-amber-500" : "border-red-500";

  return (
    <Button
      variant="ghost"
      size="icon-xs"
      className="w-4 h-4 p-0 shrink-0 hover:bg-transparent"
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      title={
        (isHardware ? "HW: " : "") +
        (enabled ? (isActive ? "Enabled (active)" : "Enabled (pending)") : "Disabled")
      }
    >
      <span
        className={cn(
          "block rounded-full transition-colors h-2.5 w-2.5",
          enabled && isActive && activeColor,
          enabled && !isActive && `border-[1.5px] ${pendingColor}`,
          !enabled && "bg-muted-foreground/30",
        )}
      />
    </Button>
  );
}

export function BreakpointsView({
  breakpoints,
  onToggleBreakpoint,
  onRemoveBreakpoint,
  onRemoveBreakpoints,
  onEnableBreakpoint,
  onEnableBreakpointGroup,
  onUpdateBreakpoint,
  onNavigateToDisassembly,
  registers,
  resolveSymbol,
}: BreakpointsViewProps) {
  const [addressInput, setAddressInput] = useState("");
  const { columnWidths, handleColumnResizeStart } = useColumnWidths<ColKey>(COLUMN_WIDTHS_KEY, DEFAULT_WIDTHS);

  // Breakpoint-level context menu
  const { contextMenu, openContextMenu, closeContextMenu } = useContextMenu<{
    breakpointId: string;
  }>();

  // Inline edit state for the name column
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  const handleAddBreakpoint = useCallback(async () => {
    const input = addressInput.trim();
    if (!input) return;

    try {
      const result = await parseAddressExpression(input, registers ?? {}, resolveSymbol);
      if (result.address !== null) {
        onToggleBreakpoint(`0x${result.address.toString(16)}`);
        setAddressInput("");
      }
    } catch (e) {
      console.error("Failed to parse address:", e);
    }
  }, [addressInput, registers, resolveSymbol, onToggleBreakpoint]);

  const startRename = useCallback(
    (breakpointId: string, currentName: string | null) => {
      setEditingId(breakpointId);
      setEditValue(currentName ?? "");
      closeContextMenu();
    },
    [closeContextMenu]
  );

  const commitRename = useCallback(() => {
    if (!editingId) return;

    const bp = breakpoints.find((b) => b.id === editingId);
    if (bp) {
      onUpdateBreakpoint(editingId, editValue.trim() || undefined, bp.group ?? undefined);
    }
    setEditingId(null);
  }, [editingId, editValue, breakpoints, onUpdateBreakpoint]);

  // Generate a unique "New Group" name
  const generateNewGroupName = useCallback(() => {
    let name = "New Group";
    let counter = 2;
    const existingGroups = new Set(breakpoints.map((b) => b.group).filter(Boolean));
    while (existingGroups.has(name)) {
      name = `New Group ${counter}`;
      counter++;
    }
    return name;
  }, [breakpoints]);

  // HW type label for display
  const hwLabel = (bp: Breakpoint) => {
    if (bp.bp_kind !== "hardware") return null;
    const parts = [bp.hw_type ?? "Execute"];
    if (bp.hw_size && bp.hw_size > 1) parts.push(`${bp.hw_size}B`);
    return parts.join(" ");
  };

  const renderBreakpointRow = (bp: Breakpoint, isDragOverlay?: boolean) => {
    const isEditingName = editingId === bp.id;
    const isHardware = bp.bp_kind === "hardware";
    const hwInfo = hwLabel(bp);
    const symbolText = bp.symbol || `${bp.module_name}+${bp.module_offset}`;

    return (
      <div
        className={cn(
          "flex items-center px-2 py-1 text-xs font-mono hover:bg-muted/50 group",
          !bp.enabled && "opacity-50",
        )}
        onContextMenu={(e) => { if (!isDragOverlay) openContextMenu(e, { breakpointId: bp.id }); }}
      >
        {/* Dot indicator */}
        <span className="w-6 shrink-0 flex items-center justify-center">
          <BreakpointDot
            enabled={bp.enabled}
            isActive={bp.is_active}
            isHardware={isHardware}
            onClick={() => onEnableBreakpoint(bp.id, !bp.enabled)}
          />
        </span>

        {/* Name (editable) */}
        <span className="shrink-0 truncate pr-1" style={{ width: columnWidths.name }}>
          {isEditingName ? (
            <InlineEditInput
              value={editValue}
              onChange={setEditValue}
              onCommit={commitRename}
              onCancel={() => setEditingId(null)}
              placeholder="breakpoint name"
            />
          ) : (
            <span
              className="cursor-text hover:underline"
              title="Click to rename"
              onClick={() => { if (!isDragOverlay) startRename(bp.id, bp.name); }}
            >
              {bp.name || <span className="text-muted-foreground/60">unnamed</span>}
            </span>
          )}
        </span>

        {/* Address (navigate) */}
        <span className="shrink-0 pr-1" style={{ width: columnWidths.address }}>
          <span
            className={cn(
              "block truncate",
              onNavigateToDisassembly ? "text-blue-400 cursor-pointer hover:underline" : "text-muted-foreground",
            )}
            title={bp.address}
            onClick={() => onNavigateToDisassembly?.(bp.address)}
          >
            {bp.address}
          </span>
        </span>

        {/* Symbol + HW type badge */}
        <span className="flex-1 min-w-0 flex items-center gap-1.5 text-muted-foreground">
          {isHardware && hwInfo && (
            <Badge size="xs" className="bg-amber-500/20 text-amber-600 dark:text-amber-400 text-[10px]">
              {hwInfo}
            </Badge>
          )}
          <TruncatedSymbol
            text={symbolText}
            className={cn("flex-1", !bp.symbol && "text-muted-foreground/50 italic")}
          />
        </span>

        {/* Delete button (visible on hover) */}
        {!isDragOverlay && (
          <span className="w-8 shrink-0 flex items-center justify-center">
            <Button
              variant="ghost"
              size="icon-xs"
              className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-opacity"
              onClick={() => onRemoveBreakpoint(bp.id)}
              title="Remove breakpoint"
            >
              <Trash2 />
            </Button>
          </span>
        )}
      </div>
    );
  };

  return (
    <DockPanel>
      <GroupedItemList
        items={breakpoints}
        minContentWidth={columnWidths.name + columnWidths.address + FIXED_COLS_PX}
        onUpdateItemGroup={(id, group) => {
          const bp = breakpoints.find((b) => b.id === id);
          if (bp) onUpdateBreakpoint(id, bp.name ?? undefined, group);
        }}
        onEnableGroup={onEnableBreakpointGroup}
        onDeleteGroup={onRemoveBreakpoints}
        renderItem={renderBreakpointRow}
        groupDotColor="red"
        renderToolbar={() => (
          <PanelToolbar>
            <Input
              placeholder="Address, symbol, rax+0x10..."
              value={addressInput}
              onChange={(e) => setAddressInput(sanitizeAddressInput(e.target.value))}
              onKeyDown={(e) => e.key === "Enter" && handleAddBreakpoint()}
              inputSize="xs"
              className="flex-1 font-mono"
            />
            <Button variant="outline" size="xs" onClick={handleAddBreakpoint} title="Add breakpoint">
              <Plus />
            </Button>
          </PanelToolbar>
        )}
        renderHeader={() => (
          <>
            <span className="w-6 shrink-0" />
            <ResizableHeaderCell width={columnWidths.name} onResizeStart={(e) => handleColumnResizeStart("name", e)}>
              Name
            </ResizableHeaderCell>
            <ResizableHeaderCell width={columnWidths.address} onResizeStart={(e) => handleColumnResizeStart("address", e)}>
              Address
            </ResizableHeaderCell>
            <span className="flex-1 min-w-0">Symbol</span>
            <span className="w-8 shrink-0" />
          </>
        )}
        renderEmptyState={() => (
          <div className="text-center">
            <span className="block h-12 w-12 rounded-full border-4 border-muted-foreground/40 mx-auto mb-4 opacity-50" />
            <p className="text-base font-medium">No breakpoints set</p>
            <p className="text-sm mt-1">Right-click in disassembly to toggle</p>
          </div>
        )}
      />

      {/* Breakpoint-level context menu */}
      {contextMenu && (() => {
        const bp = breakpoints.find((b) => b.id === contextMenu.data.breakpointId);
        return (
          <ContextMenu x={contextMenu.x} y={contextMenu.y} onClose={closeContextMenu}>
            <ContextMenuItem
              onClick={() => {
                if (bp) onEnableBreakpoint(bp.id, !bp.enabled);
              }}
            >
              {bp?.enabled ? "Disable" : "Enable"}
            </ContextMenuItem>
            <ContextMenuItem
              onClick={() => {
                if (bp) startRename(bp.id, bp.name);
              }}
            >
              Rename
            </ContextMenuItem>
            <ContextMenuItem
              onClick={() => {
                if (!bp) return;
                const name = generateNewGroupName();
                onUpdateBreakpoint(bp.id, bp.name ?? undefined, name);
              }}
            >
              Set Group
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem
              destructive
              onClick={() => onRemoveBreakpoint(contextMenu.data.breakpointId)}
            >
              Remove
            </ContextMenuItem>
          </ContextMenu>
        );
      })()}
    </DockPanel>
  );
}
