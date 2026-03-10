import { useState, useCallback } from "react";
import { ScrollArea } from "./ui/scroll-area";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Trash2, Plus, ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { Breakpoint } from "@/hooks/useBreakpoints";
import { useContextMenu } from "@/hooks/useContextMenu";
import { RegisterContext, SymbolResolver, sanitizeAddressInput, parseAddressExpression } from "@/lib/hexUtils";
import {
  DndContext,
  DragOverlay,
  pointerWithin,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
} from "@dnd-kit/core";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

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

/** Breakpoint dot color depends on bp_kind: red for software, amber/orange for hardware */
function BreakpointDot({ enabled, isActive, isHardware, onClick }: { enabled: boolean; isActive: boolean; isHardware: boolean; onClick: () => void }) {
  const activeColor = isHardware ? "bg-amber-500" : "bg-red-500";
  const pendingColor = isHardware ? "border-amber-500" : "border-red-500";

  return (
    <button
      className="w-4 h-4 shrink-0 flex items-center justify-center"
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
    </button>
  );
}

/** Draggable breakpoint row wrapper */
function DraggableBreakpointRow({ bp, children }: { bp: Breakpoint; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: bp.id,
    data: { type: "breakpoint", bp },
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : undefined,
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      {children}
    </div>
  );
}

/** Droppable group zone */
function DroppableGroupZone({ groupName, children }: { groupName: string; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({
    id: `group:${groupName}`,
    data: { type: "group", groupName },
  });

  return (
    <div ref={setNodeRef} className={cn(isOver && "ring-1 ring-primary/50 bg-primary/5 rounded")}>
      {children}
    </div>
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
    breakpointId?: string;
    groupName?: string;
    field: "name" | "group";
  } | null>(null);
  const [editValue, setEditValue] = useState("");

  // Drag state
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [dragOverGroupId, setDragOverGroupId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    })
  );

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

  const startGroupRename = useCallback(
    (groupName: string) => {
      setEditingField({ groupName, field: "group" });
      setEditValue(groupName);
      closeContextMenu();
    },
    [closeContextMenu]
  );

  const commitEdit = useCallback(() => {
    if (!editingField) return;

    if (editingField.breakpointId) {
      // Editing a breakpoint's name or group
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
    } else if (editingField.groupName) {
      // Renaming a group — update all breakpoints in that group
      const newGroupName = editValue.trim();
      if (newGroupName && newGroupName !== editingField.groupName) {
        const groupBps = breakpoints.filter((bp) => bp.group === editingField.groupName);
        for (const bp of groupBps) {
          onUpdateBreakpoint(bp.id, bp.name ?? undefined, newGroupName);
        }
      }
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

  // Double-click handler for breakpoint name
  const handleNameDoubleClick = useCallback((bp: Breakpoint) => {
    startEdit(bp.id, "name", bp.name);
  }, [startEdit]);

  // Double-click handler for group header
  const handleGroupDoubleClick = useCallback((groupName: string, e: React.MouseEvent) => {
    e.stopPropagation();
    startGroupRename(groupName);
  }, [startGroupRename]);

  // Drag handlers
  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveDragId(event.active.id as string);
  }, []);

  const handleDragOver = useCallback((event: DragOverEvent) => {
    const over = event.over;
    if (!over) {
      setDragOverGroupId(null);
      return;
    }
    const overId = over.id as string;
    if (overId.startsWith("group:")) {
      setDragOverGroupId(overId.slice(6));
    } else if (overId === "ungrouped") {
      setDragOverGroupId("__ungrouped__");
    } else {
      // Dragging over another breakpoint — check its group
      const overBp = breakpoints.find((b) => b.id === overId);
      setDragOverGroupId(overBp?.group ?? "__ungrouped__");
    }
  }, [breakpoints]);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    setActiveDragId(null);
    setDragOverGroupId(null);

    if (!over) return;

    const draggedBp = breakpoints.find((b) => b.id === active.id);
    if (!draggedBp) return;

    const overId = over.id as string;
    let targetGroup: string | undefined;

    if (overId === "ungrouped" || overId === "group:__ungrouped__") {
      // Drop on ungrouped zone — clear group
      targetGroup = undefined;
    } else if (overId === "group:__new_group__") {
      const name = generateNewGroupName();
      targetGroup = name;
      // Start editing the new group name after state updates
      setTimeout(() => startGroupRename(name), 0);
    } else if (overId.startsWith("group:")) {
      targetGroup = overId.slice(6);
    } else {
      // Dropped on another breakpoint — take its group
      const overBp = breakpoints.find((b) => b.id === overId);
      targetGroup = overBp?.group ?? undefined;
    }

    // Only update if group actually changed
    const currentGroup = draggedBp.group ?? undefined;
    if (targetGroup !== currentGroup) {
      onUpdateBreakpoint(draggedBp.id, draggedBp.name ?? undefined, targetGroup);
    }
  }, [breakpoints, onUpdateBreakpoint, generateNewGroupName, startGroupRename]);

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

  const activeDragBp = activeDragId ? breakpoints.find((b) => b.id === activeDragId) : null;

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

    const row = (
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
          className="flex-1 min-w-0 truncate"
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
              className="h-5 text-xs px-1 py-0 rounded-sm shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
              placeholder={isEditingGroup ? "group name" : "breakpoint name"}
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
        {!isDragOverlay && (
          <button
            className="h-4 w-4 shrink-0 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-opacity"
            onClick={() => onRemoveBreakpoint(bp.id)}
            title="Remove breakpoint"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        )}
      </div>
    );

    if (isDragOverlay) return row;

    return (
      <DraggableBreakpointRow key={bp.id} bp={bp}>
        {row}
      </DraggableBreakpointRow>
    );
  };

  const isEditingGroupHeader = (groupName: string) =>
    editingField?.groupName === groupName && editingField?.field === "group";

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
          <DndContext
            sensors={sensors}
            collisionDetection={pointerWithin}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDragEnd={handleDragEnd}
          >
            <div>
              {/* Ungrouped breakpoints — droppable zone */}
              <DroppableGroupZone groupName="__ungrouped__">
                <div id="ungrouped">
                  {ungrouped.map((bp) => renderBreakpointRow(bp))}
                  {ungrouped.length === 0 && activeDragId && (
                    <div className="px-2 py-2 text-xs text-muted-foreground/50 italic text-center">
                      Drop here to ungroup
                    </div>
                  )}
                </div>
              </DroppableGroupZone>

              {/* Grouped breakpoints */}
              {Array.from(groups.entries()).map(([groupName, groupBps]) => {
                const isCollapsed = collapsedGroups.has(groupName);
                const allEnabled = groupBps.every((bp) => bp.enabled);
                const noneEnabled = groupBps.every((bp) => !bp.enabled);

                return (
                  <DroppableGroupZone key={groupName} groupName={groupName}>
                    {/* Group header */}
                    <div
                      className={cn(
                        "flex items-center gap-1.5 px-2 py-1 bg-muted/20 border-y border-border/50 text-xs font-medium cursor-pointer hover:bg-muted/40",
                        dragOverGroupId === groupName && "bg-primary/10",
                      )}
                      onClick={() => toggleGroupCollapse(groupName)}
                      onContextMenu={(e) => openContextMenu(e, { groupName })}
                      onDoubleClick={(e) => handleGroupDoubleClick(groupName, e)}
                    >
                      <span className="w-4 shrink-0 flex items-center justify-center">
                        {isCollapsed ? (
                          <ChevronRight className="h-3 w-3" />
                        ) : (
                          <ChevronDown className="h-3 w-3" />
                        )}
                      </span>
                      {/* Group dot */}
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
                      {isEditingGroupHeader(groupName) ? (
                        <Input
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onKeyDown={(e) => {
                            e.stopPropagation();
                            if (e.key === "Enter") commitEdit();
                            if (e.key === "Escape") setEditingField(null);
                          }}
                          onClick={(e) => e.stopPropagation()}
                          onBlur={commitEdit}
                          className="h-5 text-xs px-1 py-0 rounded-sm shadow-none focus-visible:ring-0 focus-visible:ring-offset-0 flex-1"
                          placeholder="group name"
                          autoFocus
                        />
                      ) : (
                        <>
                          <span>{groupName}</span>
                          <span className="text-muted-foreground ml-1">({groupBps.length})</span>
                        </>
                      )}
                    </div>
                    {/* Group members */}
                    {!isCollapsed && groupBps.map((bp) => renderBreakpointRow(bp))}
                  </DroppableGroupZone>
                );
              })}

              {/* New group drop zone — only visible while dragging */}
              {activeDragId && (
                <DroppableGroupZone groupName="__new_group__">
                  <div
                    className={cn(
                      "px-2 py-2 text-xs text-muted-foreground/50 italic text-center border-t border-border/50",
                      dragOverGroupId === "__new_group__" && "bg-primary/10 text-primary",
                    )}
                  >
                    Drop here to create new group
                  </div>
                </DroppableGroupZone>
              )}
            </div>

            {/* Drag overlay */}
            <DragOverlay dropAnimation={null}>
              {activeDragBp && renderBreakpointRow(activeDragBp, true)}
            </DragOverlay>
          </DndContext>
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
                    if (!bp) return;
                    const name = generateNewGroupName();
                    onUpdateBreakpoint(bp.id, bp.name ?? undefined, name);
                    closeContextMenu();
                    // Start renaming the newly created group after state updates
                    setTimeout(() => startGroupRename(name), 0);
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
              <button
                className="w-full px-3 py-1.5 text-sm text-left hover:bg-accent hover:text-accent-foreground"
                onClick={() => {
                  startGroupRename(contextMenu.data.groupName!);
                }}
              >
                Rename Group
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
