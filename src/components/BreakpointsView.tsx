import { useState, useCallback } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Trash2, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { Breakpoint } from "@/hooks/useBreakpoints";
import { useContextMenu } from "@/hooks/useContextMenu";
import { RegisterContext, SymbolResolver, sanitizeAddressInput, parseAddressExpression } from "@/lib/hexUtils";
import { GroupedItemList } from "./GroupedItemList";
import { DockPanel, PanelToolbar } from "./ui/panel";
import { ContextMenu, ContextMenuItem, ContextMenuSeparator } from "./ui/context-menu";
import { TruncatedSymbol } from "./ui/truncated-symbol";

interface BreakpointsViewProps {
  breakpoints: Breakpoint[];
  onToggleBreakpoint: (address: string) => void;
  onRemoveBreakpoint: (id: string) => void;
  onRemoveBreakpoints: (ids: string[]) => void;
  onEnableBreakpoint: (id: string, enabled: boolean) => void;
  onEnableBreakpointGroup: (group: string, enabled: boolean) => void;
  onUpdateBreakpoint: (id: string, name?: string, group?: string) => void;
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
  registers,
  resolveSymbol,
}: BreakpointsViewProps) {
  const [addressInput, setAddressInput] = useState("");

  // Breakpoint-level context menu
  const { contextMenu, openContextMenu, closeContextMenu } = useContextMenu<{
    breakpointId: string;
  }>();

  // Inline edit state for name/group
  const [editingField, setEditingField] = useState<{
    breakpointId: string;
    field: "name" | "group";
  } | null>(null);
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

  const startEdit = useCallback(
    (breakpointId: string, field: "name" | "group", currentValue: string | null) => {
      setEditingField({ breakpointId, field });
      setEditValue(currentValue ?? "");
      closeContextMenu();
    },
    [closeContextMenu]
  );

  const commitEdit = useCallback(() => {
    if (!editingField) return;

    const bp = breakpoints.find((b) => b.id === editingField.breakpointId);
    if (!bp) {
      setEditingField(null);
      return;
    }

    if (editingField.field === "name") {
      onUpdateBreakpoint(editingField.breakpointId, editValue || undefined, bp.group ?? undefined);
    } else {
      onUpdateBreakpoint(editingField.breakpointId, bp.name ?? undefined, editValue || undefined);
    }
    setEditingField(null);
  }, [editingField, editValue, breakpoints, onUpdateBreakpoint]);

  const handleNameDoubleClick = useCallback((bp: Breakpoint) => {
    startEdit(bp.id, "name", bp.name);
  }, [startEdit]);

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
    const isEditingName = editingField?.breakpointId === bp.id && editingField?.field === "name";
    const isEditingGroup = editingField?.breakpointId === bp.id && editingField?.field === "group";
    const isHardware = bp.bp_kind === "hardware";
    const hwInfo = hwLabel(bp);

    return (
      <div
        className={cn(
          "flex items-center gap-1.5 px-2 py-1 hover:bg-muted/50 group text-xs",
          !bp.enabled && "opacity-50",
          isDragOverlay && "bg-popover border rounded shadow-md",
        )}
        onContextMenu={(e) => { if (!isDragOverlay) openContextMenu(e, { breakpointId: bp.id }); }}
      >
        {/* Dot indicator */}
        <BreakpointDot
          enabled={bp.enabled}
          isActive={bp.is_active}
          isHardware={isHardware}
          onClick={() => onEnableBreakpoint(bp.id, !bp.enabled)}
        />

        {/* Address */}
        <span className="font-mono text-muted-foreground shrink-0 w-[120px] truncate" title={bp.address}>
          {bp.address}
        </span>

        {/* HW type badge */}
        {isHardware && hwInfo && (
          <span className="shrink-0 text-[10px] px-1 py-0 rounded bg-amber-500/20 text-amber-600 dark:text-amber-400 font-medium">
            {hwInfo}
          </span>
        )}

        {/* Name / symbol or inline edit */}
        <span
          className="flex-1 min-w-0"
          onDoubleClick={() => { if (!isDragOverlay) handleNameDoubleClick(bp); }}
        >
          {(isEditingName || isEditingGroup) ? (
            <Input
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitEdit();
                if (e.key === "Escape") setEditingField(null);
              }}
              onBlur={commitEdit}
              inputSize="xs"
              className="px-1 py-0 rounded-sm shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
              placeholder={isEditingGroup ? "group name" : "breakpoint name"}
              autoFocus
            />
          ) : (
            <TruncatedSymbol
              text={bp.name || bp.symbol || `${bp.module_name}+${bp.module_offset}`}
              className={cn(!bp.name && !bp.symbol && "text-muted-foreground/50 italic")}
            />
          )}
        </span>

        {/* Delete button (visible on hover) */}
        {!isDragOverlay && (
          <Button
            variant="ghost"
            size="icon-xs"
            className="shrink-0 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-opacity"
            onClick={() => onRemoveBreakpoint(bp.id)}
            title="Remove breakpoint"
          >
            <Trash2 />
          </Button>
        )}
      </div>
    );
  };

  return (
    <DockPanel>
      <GroupedItemList
        items={breakpoints}
        minContentWidth="18rem"
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
        renderEmptyState={() => (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
            <div className="text-center">
              <span className="block h-12 w-12 rounded-full border-4 border-muted-foreground/40 mx-auto mb-4 opacity-50" />
              <p className="text-base font-medium">No breakpoints set</p>
              <p className="text-sm mt-1">Right-click in disassembly to toggle</p>
            </div>
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
