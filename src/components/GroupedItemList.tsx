import { useState, useCallback } from "react";
import { ScrollArea } from "./ui/scroll-area";
import { Input } from "./ui/input";
import { ChevronDown, ChevronRight, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useContextMenu } from "@/hooks/useContextMenu";
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

export interface GroupableItem {
  id: string;
  group: string | null;
  enabled: boolean;
}

export interface GroupedItemListProps<T extends GroupableItem> {
  items: T[];
  onUpdateItemGroup: (id: string, group: string | undefined) => void;
  onEnableGroup: (group: string, enabled: boolean) => void;
  onDeleteGroup: (itemIds: string[]) => void;
  renderItem: (item: T, isDragOverlay?: boolean) => React.ReactNode;
  renderToolbar?: () => React.ReactNode;
  renderEmptyState?: () => React.ReactNode;
  /** Color class for group dot (default "red") */
  groupDotColor?: string;
}

function DraggableItemRow<T extends GroupableItem>({ item, children }: { item: T; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
    data: { type: "item", item },
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

export function GroupedItemList<T extends GroupableItem>({
  items,
  onUpdateItemGroup,
  onEnableGroup,
  onDeleteGroup,
  renderItem,
  renderToolbar,
  renderEmptyState,
  groupDotColor = "red",
}: GroupedItemListProps<T>) {
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  const { contextMenu, contextMenuRef, openContextMenu, closeContextMenu } = useContextMenu<{
    groupName: string;
  }>();

  const [editingGroup, setEditingGroup] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [dragOverGroupId, setDragOverGroupId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    })
  );

  const toggleGroupCollapse = useCallback((group: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  }, []);

  const generateNewGroupName = useCallback(() => {
    let name = "New Group";
    let counter = 2;
    const existingGroups = new Set(items.map((i) => i.group).filter(Boolean));
    while (existingGroups.has(name)) {
      name = `New Group ${counter}`;
      counter++;
    }
    return name;
  }, [items]);

  const startGroupRename = useCallback(
    (groupName: string) => {
      setEditingGroup(groupName);
      setEditValue(groupName);
      closeContextMenu();
    },
    [closeContextMenu]
  );

  const commitGroupRename = useCallback(() => {
    if (!editingGroup) return;
    const newName = editValue.trim();
    if (newName && newName !== editingGroup) {
      const groupItems = items.filter((i) => i.group === editingGroup);
      for (const item of groupItems) {
        onUpdateItemGroup(item.id, newName);
      }
    }
    setEditingGroup(null);
  }, [editingGroup, editValue, items, onUpdateItemGroup]);

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
      const overItem = items.find((i) => i.id === overId);
      setDragOverGroupId(overItem?.group ?? "__ungrouped__");
    }
  }, [items]);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    setActiveDragId(null);
    setDragOverGroupId(null);

    if (!over) return;

    const draggedItem = items.find((i) => i.id === active.id);
    if (!draggedItem) return;

    const overId = over.id as string;
    let targetGroup: string | undefined;

    if (overId === "ungrouped" || overId === "group:__ungrouped__") {
      targetGroup = undefined;
    } else if (overId === "group:__new_group__") {
      const name = generateNewGroupName();
      targetGroup = name;
      setTimeout(() => startGroupRename(name), 0);
    } else if (overId.startsWith("group:")) {
      targetGroup = overId.slice(6);
    } else {
      const overItem = items.find((i) => i.id === overId);
      targetGroup = overItem?.group ?? undefined;
    }

    const currentGroup = draggedItem.group ?? undefined;
    if (targetGroup !== currentGroup) {
      onUpdateItemGroup(draggedItem.id, targetGroup);
    }
  }, [items, onUpdateItemGroup, generateNewGroupName, startGroupRename]);

  // Group items
  const ungrouped = items.filter((i) => !i.group);
  const groups = new Map<string, T[]>();
  for (const item of items) {
    if (item.group) {
      if (!groups.has(item.group)) groups.set(item.group, []);
      groups.get(item.group)!.push(item);
    }
  }

  const activeDragItem = activeDragId ? items.find((i) => i.id === activeDragId) : null;

  // Dot color classes
  const dotActive = groupDotColor === "purple" ? "bg-purple-500" : "bg-red-500";
  const dotPartial = groupDotColor === "purple" ? "bg-purple-500/50" : "bg-red-500/50";

  const renderGroupedContent = () => (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
    >
      <div>
        {/* Ungrouped items */}
        <DroppableGroupZone groupName="__ungrouped__">
          <div id="ungrouped">
            {ungrouped.map((item) => (
              <DraggableItemRow key={item.id} item={item}>
                {renderItem(item)}
              </DraggableItemRow>
            ))}
            {ungrouped.length === 0 && activeDragId && (
              <div className="px-2 py-2 text-xs text-muted-foreground/50 italic text-center">
                Drop here to ungroup
              </div>
            )}
          </div>
        </DroppableGroupZone>

        {/* Grouped items */}
        {Array.from(groups.entries()).map(([groupName, groupItems]) => {
          const isCollapsed = collapsedGroups.has(groupName);
          const allEnabled = groupItems.every((i) => i.enabled);
          const noneEnabled = groupItems.every((i) => !i.enabled);
          const isEditingHeader = editingGroup === groupName;

          return (
            <DroppableGroupZone key={groupName} groupName={groupName}>
              {/* Group header */}
              <div
                className={cn(
                  "group flex items-center gap-1.5 px-2 py-1 bg-muted/20 border-y border-border/50 text-xs font-medium cursor-pointer hover:bg-muted/40",
                  dragOverGroupId === groupName && "bg-primary/10",
                )}
                onClick={() => toggleGroupCollapse(groupName)}
                onContextMenu={(e) => openContextMenu(e, { groupName })}
                onDoubleClick={(e) => handleGroupDoubleClick(groupName, e)}
              >
                <span className="w-4 shrink-0 flex items-center justify-center">
                  {isCollapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                </span>
                {/* Group dot */}
                <button
                  className="w-4 h-4 shrink-0 flex items-center justify-center"
                  onClick={(e) => {
                    e.stopPropagation();
                    onEnableGroup(groupName, !allEnabled);
                  }}
                  title={allEnabled ? "Disable group" : "Enable group"}
                >
                  <span
                    className={cn(
                      "block h-2.5 w-2.5 rounded-full transition-colors",
                      allEnabled && dotActive,
                      noneEnabled && "bg-muted-foreground/30",
                      !allEnabled && !noneEnabled && dotPartial,
                    )}
                  />
                </button>
                {isEditingHeader ? (
                  <Input
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Enter") commitGroupRename();
                      if (e.key === "Escape") setEditingGroup(null);
                    }}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={commitGroupRename}
                    className="h-5 text-xs px-1 py-0 rounded-sm shadow-none focus-visible:ring-0 focus-visible:ring-offset-0 flex-1"
                    placeholder="group name"
                    autoFocus
                  />
                ) : (
                  <>
                    <span>{groupName}</span>
                    <span className="text-muted-foreground ml-1">({groupItems.length})</span>
                    <span className="flex-1" />
                    <button
                      className="h-4 w-4 shrink-0 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-opacity"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteGroup(groupItems.map((i) => i.id));
                      }}
                      title="Remove group"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </>
                )}
              </div>
              {/* Group members */}
              {!isCollapsed && groupItems.map((item) => (
                <DraggableItemRow key={item.id} item={item}>
                  {renderItem(item)}
                </DraggableItemRow>
              ))}
            </DroppableGroupZone>
          );
        })}

        {/* New group drop zone */}
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
        {activeDragItem && renderItem(activeDragItem, true)}
      </DragOverlay>
    </DndContext>
  );

  return (
    <>
      {/* Toolbar */}
      {renderToolbar?.()}

      {/* List */}
      {items.length === 0 ? (
        renderEmptyState?.()
      ) : (
        <ScrollArea className="flex-1 min-h-0">
          {renderGroupedContent()}
        </ScrollArea>
      )}

      {/* Group context menu */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="fixed z-50 bg-popover text-popover-foreground rounded-md border shadow-md py-1 min-w-[160px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            className="w-full px-3 py-1.5 text-sm text-left hover:bg-accent hover:text-accent-foreground"
            onClick={() => {
              onEnableGroup(contextMenu.data.groupName, true);
              closeContextMenu();
            }}
          >
            Enable All
          </button>
          <button
            className="w-full px-3 py-1.5 text-sm text-left hover:bg-accent hover:text-accent-foreground"
            onClick={() => {
              onEnableGroup(contextMenu.data.groupName, false);
              closeContextMenu();
            }}
          >
            Disable All
          </button>
          <button
            className="w-full px-3 py-1.5 text-sm text-left hover:bg-accent hover:text-accent-foreground"
            onClick={() => startGroupRename(contextMenu.data.groupName)}
          >
            Rename Group
          </button>
          <div className="border-t border-border my-1" />
          <button
            className="w-full px-3 py-1.5 text-sm text-left hover:bg-accent hover:text-accent-foreground text-destructive"
            onClick={() => {
              const groupItems = items.filter((i) => i.group === contextMenu.data.groupName);
              onDeleteGroup(groupItems.map((i) => i.id));
              closeContextMenu();
            }}
          >
            Remove Group
          </button>
        </div>
      )}
    </>
  );
}
