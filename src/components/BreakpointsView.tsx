import { useState, useCallback } from "react";
import { ScrollArea } from "./ui/scroll-area";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Trash2, Plus, ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { Breakpoint } from "@/hooks/useBreakpoints";
import { useContextMenu } from "@/hooks/useContextMenu";
import { RegisterContext, SymbolResolver, sanitizeAddressInput, parseAddressExpression } from "@/lib/hexUtils";

interface BreakpointsViewProps {
  breakpoints: Breakpoint[];
  onToggleBreakpoint: (address: string) => void;
  onRemoveBreakpoint: (id: string) => void;
  onEnableBreakpoint: (id: string, enabled: boolean) => void;
  onEnableBreakpointGroup: (group: string, enabled: boolean) => void;
  onUpdateBreakpoint: (id: string, name?: string, group?: string) => void;
  registers?: RegisterContext;
  resolveSymbol?: SymbolResolver;
}

/** Clickable breakpoint dot: red filled = active, red outline = enabled/unresolved, gray = disabled */
function BreakpointDot({ enabled, isActive, onClick }: { enabled: boolean; isActive: boolean; onClick: () => void }) {
  return (
    <button
      className="w-4 h-4 shrink-0 flex items-center justify-center"
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      title={enabled ? (isActive ? "Enabled (active)" : "Enabled (pending)") : "Disabled"}
    >
      <span
        className={cn(
          "block rounded-full transition-colors",
          enabled && isActive && "h-2.5 w-2.5 bg-red-500",
          enabled && !isActive && "h-2.5 w-2.5 border-[1.5px] border-red-500",
          !enabled && "h-2.5 w-2.5 bg-muted-foreground/30",
        )}
      />
    </button>
  );
}

export function BreakpointsView({
  breakpoints,
  onToggleBreakpoint,
  onRemoveBreakpoint,
  onEnableBreakpoint,
  onEnableBreakpointGroup,
  onUpdateBreakpoint,
  registers,
  resolveSymbol,
}: BreakpointsViewProps) {
  const [addressInput, setAddressInput] = useState("");
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  // Context menu
  const { contextMenu, contextMenuRef, openContextMenu, closeContextMenu } = useContextMenu<{
    breakpointId?: string;
    groupName?: string;
  }>();

  // Inline edit state
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

  const toggleGroupCollapse = useCallback((group: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(group)) {
        next.delete(group);
      } else {
        next.add(group);
      }
      return next;
    });
  }, []);

  // Group breakpoints
  const ungrouped = breakpoints.filter((bp) => !bp.group);
  const groups = new Map<string, Breakpoint[]>();
  for (const bp of breakpoints) {
    if (bp.group) {
      if (!groups.has(bp.group)) {
        groups.set(bp.group, []);
      }
      groups.get(bp.group)!.push(bp);
    }
  }

  const renderBreakpointRow = (bp: Breakpoint) => {
    const isEditingName = editingField?.breakpointId === bp.id && editingField?.field === "name";
    const isEditingGroup = editingField?.breakpointId === bp.id && editingField?.field === "group";

    return (
      <div
        key={bp.id}
        className={cn(
          "flex items-center gap-1.5 px-2 py-1 hover:bg-muted/50 group text-xs",
          !bp.enabled && "opacity-50",
        )}
        onContextMenu={(e) => openContextMenu(e, { breakpointId: bp.id })}
      >
        {/* Single dot indicator — click to toggle enable/disable */}
        <BreakpointDot
          enabled={bp.enabled}
          isActive={bp.is_active}
          onClick={() => onEnableBreakpoint(bp.id, !bp.enabled)}
        />

        {/* Address */}
        <span className="font-mono text-muted-foreground shrink-0 w-[120px] truncate" title={bp.address}>
          {bp.address}
        </span>

        {/* Name / symbol or inline edit */}
        <span className="flex-1 min-w-0 truncate">
          {(isEditingName || isEditingGroup) ? (
            <Input
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitEdit();
                if (e.key === "Escape") setEditingField(null);
              }}
              onBlur={commitEdit}
              className="h-5 text-xs px-1 py-0 rounded-sm shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
              placeholder={isEditingGroup ? "group name" : undefined}
              autoFocus
            />
          ) : (
            <span
              className={cn(!bp.name && !bp.symbol && "text-muted-foreground/50 italic")}
              title={bp.symbol || `${bp.module_name}+${bp.module_offset}`}
            >
              {bp.name || bp.symbol || `${bp.module_name}+${bp.module_offset}`}
            </span>
          )}
        </span>

        {/* Delete button (visible on hover) */}
        <button
          className="h-4 w-4 shrink-0 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-opacity"
          onClick={() => onRemoveBreakpoint(bp.id)}
          title="Remove breakpoint"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>
    );
  };

  return (
    <div className="absolute inset-0 flex flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-1 p-2 border-b border-border bg-muted/30 shrink-0">
        <Input
          placeholder="Address, symbol, rax+0x10..."
          value={addressInput}
          onChange={(e) => setAddressInput(sanitizeAddressInput(e.target.value))}
          onKeyDown={(e) => e.key === "Enter" && handleAddBreakpoint()}
          className="flex-1 h-7 text-xs font-mono"
        />
        <Button variant="outline" size="sm" onClick={handleAddBreakpoint} className="h-7 px-2" title="Add breakpoint">
          <Plus className="h-3 w-3" />
        </Button>
      </div>

      {/* Breakpoint list */}
      <ScrollArea className="flex-1 min-h-0">
        {breakpoints.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
            <div className="text-center">
              <span className="block h-12 w-12 rounded-full border-4 border-muted-foreground/40 mx-auto mb-4 opacity-50" />
              <p className="text-base font-medium">No breakpoints set</p>
              <p className="text-sm mt-1">Right-click in disassembly to toggle</p>
            </div>
          </div>
        ) : (
          <div>
            {/* Ungrouped breakpoints */}
            {ungrouped.map(renderBreakpointRow)}

            {/* Grouped breakpoints */}
            {Array.from(groups.entries()).map(([groupName, groupBps]) => {
              const isCollapsed = collapsedGroups.has(groupName);
              const allEnabled = groupBps.every((bp) => bp.enabled);
              const noneEnabled = groupBps.every((bp) => !bp.enabled);

              return (
                <div key={groupName}>
                  {/* Group header */}
                  <div
                    className="flex items-center gap-1.5 px-2 py-1 bg-muted/20 border-y border-border/50 text-xs font-medium cursor-pointer hover:bg-muted/40"
                    onClick={() => toggleGroupCollapse(groupName)}
                    onContextMenu={(e) => openContextMenu(e, { groupName })}
                  >
                    <span className="w-4 shrink-0 flex items-center justify-center">
                      {isCollapsed ? (
                        <ChevronRight className="h-3 w-3" />
                      ) : (
                        <ChevronDown className="h-3 w-3" />
                      )}
                    </span>
                    {/* Group dot — click to batch-toggle */}
                    <button
                      className="w-4 h-4 shrink-0 flex items-center justify-center"
                      onClick={(e) => {
                        e.stopPropagation();
                        onEnableBreakpointGroup(groupName, !allEnabled);
                      }}
                      title={allEnabled ? "Disable group" : "Enable group"}
                    >
                      <span
                        className={cn(
                          "block h-2.5 w-2.5 rounded-full transition-colors",
                          allEnabled && "bg-red-500",
                          noneEnabled && "bg-muted-foreground/30",
                          !allEnabled && !noneEnabled && "bg-red-500/50",
                        )}
                      />
                    </button>
                    <span>{groupName}</span>
                    <span className="text-muted-foreground ml-1">({groupBps.length})</span>
                  </div>
                  {/* Group members */}
                  {!isCollapsed && groupBps.map(renderBreakpointRow)}
                </div>
              );
            })}
          </div>
        )}
      </ScrollArea>

      {/* Context Menu */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="fixed z-50 bg-popover text-popover-foreground rounded-md border shadow-md py-1 min-w-[160px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          {contextMenu.data.breakpointId && (() => {
            const bp = breakpoints.find((b) => b.id === contextMenu.data.breakpointId);
            return (
              <>
                <button
                  className="w-full px-3 py-1.5 text-sm text-left hover:bg-accent hover:text-accent-foreground"
                  onClick={() => {
                    if (bp) onEnableBreakpoint(bp.id, !bp.enabled);
                    closeContextMenu();
                  }}
                >
                  {bp?.enabled ? "Disable" : "Enable"}
                </button>
                <button
                  className="w-full px-3 py-1.5 text-sm text-left hover:bg-accent hover:text-accent-foreground"
                  onClick={() => {
                    if (bp) startEdit(bp.id, "name", bp.name);
                  }}
                >
                  Rename
                </button>
                <button
                  className="w-full px-3 py-1.5 text-sm text-left hover:bg-accent hover:text-accent-foreground"
                  onClick={() => {
                    if (bp) startEdit(bp.id, "group", bp.group);
                  }}
                >
                  Set Group
                </button>
                <div className="border-t border-border my-1" />
                <button
                  className="w-full px-3 py-1.5 text-sm text-left hover:bg-accent hover:text-accent-foreground text-destructive"
                  onClick={() => {
                    onRemoveBreakpoint(contextMenu.data.breakpointId!);
                    closeContextMenu();
                  }}
                >
                  Remove
                </button>
              </>
            );
          })()}
          {contextMenu.data.groupName && (
            <>
              <button
                className="w-full px-3 py-1.5 text-sm text-left hover:bg-accent hover:text-accent-foreground"
                onClick={() => {
                  onEnableBreakpointGroup(contextMenu.data.groupName!, true);
                  closeContextMenu();
                }}
              >
                Enable All
              </button>
              <button
                className="w-full px-3 py-1.5 text-sm text-left hover:bg-accent hover:text-accent-foreground"
                onClick={() => {
                  onEnableBreakpointGroup(contextMenu.data.groupName!, false);
                  closeContextMenu();
                }}
              >
                Disable All
              </button>
              <div className="border-t border-border my-1" />
              <button
                className="w-full px-3 py-1.5 text-sm text-left hover:bg-accent hover:text-accent-foreground text-destructive"
                onClick={() => {
                  const groupBps = breakpoints.filter((bp) => bp.group === contextMenu.data.groupName);
                  for (const bp of groupBps) {
                    onRemoveBreakpoint(bp.id);
                  }
                  closeContextMenu();
                }}
              >
                Remove Group
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
