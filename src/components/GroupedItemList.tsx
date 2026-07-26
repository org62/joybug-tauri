import { useState, useCallback } from "react";
import { InlineEditInput } from "./ui/inline-edit-input";
import { Button } from "./ui/button";
import { ChevronDown, ChevronRight, GripVertical, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useContextMenu } from "@/hooks/useContextMenu";
import { PanelBody } from "./ui/panel";
import { ContextMenu, ContextMenuItem, ContextMenuSeparator } from "./ui/context-menu";
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
  /**
   * Column header cells. GroupedItemList supplies the row chrome (padding,
   * typography, drag-gutter spacer), renders it inside the scroll content (so
   * it scrolls horizontally with the rows), and keeps it sticky during
   * vertical scroll.
   */
  renderHeader?: () => React.ReactNode;
  /** Empty-state content; GroupedItemList centers it in the panel body. */
  renderEmptyState?: () => React.ReactNode;
  /** Color class for group dot (default "red") */
  groupDotColor?: string;
  /**
   * Floor for the scroll content width in px, excluding the drag-handle
   * gutter (added internally). When set, the list scrolls horizontally
   * instead of squeezing rows below this width.
   */
  minContentWidth?: number;
}

/** Width of the drag-handle gutter (w-4) the list prepends to every row. */
const GUTTER_PX = 16;

/** Drag-handle gutter shared by rows and the drag overlay so they align. */
function DragHandleGutter({ interactive, ...props }: { interactive?: boolean } & React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      {...props}
      className={cn(
        "w-4 shrink-0 self-stretch flex items-center justify-center text-muted-foreground/40 select-none touch-none",
        interactive && "cursor-grab active:cursor-grabbing hover:text-muted-foreground",
        props.className,
      )}
    >
      <GripVertical className="h-3 w-3" />
    </span>
  );
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

  // Listeners go on the handle only — dragging starts from the grip, never
  // from the row content (which has its own clicks, selection and editing).
  return (
    <div ref={setNodeRef} style={style} className="flex items-stretch">
      <DragHandleGutter interactive {...attributes} {...listeners} title="Drag to move into a group" />
      <div className="flex-1 min-w-0">{children}</div>
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
  renderHeader,
  renderEmptyState,
  groupDotColor = "red",
  minContentWidth,
}: GroupedItemListProps<T>) {
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  const { contextMenu, openContextMenu, closeContextMenu } = useContextMenu<{
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
  const dotActive = groupDotColor === "purple" ? "bg-syn-patched" : "bg-destructive";
  const dotPartial = groupDotColor === "purple" ? "bg-syn-patched/50" : "bg-destructive/50";

  const renderGroupedContent = () => (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
    >
      {/* w-0 zeroes the intrinsic max-content contribution so long symbols
          can't widen the scroll content; min-w-full restores fill (same idiom
          as RegisterView). The inline minWidth adds the horizontal-scroll
          floor on top. */}
      <div
        className="w-0 min-w-full"
        style={minContentWidth ? { minWidth: `max(100%, ${minContentWidth + GUTTER_PX}px)` } : undefined}
      >
        {/* Column header — inside the min-width wrapper so it scrolls
            horizontally with the rows; sticky against vertical scroll */}
        {renderHeader && (
          <div className="sticky top-0 z-10 bg-background border-b border-border flex">
            <span className="w-4 shrink-0" />
            <div className="flex-1 min-w-0 flex items-center px-2 py-1 text-xs text-muted-foreground font-medium select-none">
              {renderHeader()}
            </div>
          </div>
        )}

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
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="w-4 h-4 p-0 shrink-0 hover:bg-transparent"
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
                </Button>
                {isEditingHeader ? (
                  <InlineEditInput
                    value={editValue}
                    onChange={setEditValue}
                    onCommit={commitGroupRename}
                    onCancel={() => setEditingGroup(null)}
                    className="flex-1"
                    placeholder="group name"
                  />
                ) : (
                  <>
                    <span>{groupName}</span>
                    <span className="text-muted-foreground ml-1">({groupItems.length})</span>
                    <span className="flex-1" />
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="h-4 w-4 shrink-0 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-opacity"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteGroup(groupItems.map((i) => i.id));
                      }}
                      title="Remove group"
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
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
        {activeDragItem && (
          <div className="flex items-stretch bg-popover border rounded shadow-md">
            <DragHandleGutter />
            <div className="flex-1 min-w-0">{renderItem(activeDragItem, true)}</div>
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );

  return (
    <>
      {/* Toolbar */}
      {renderToolbar?.()}

      {/* List */}
      {items.length === 0 ? (
        renderEmptyState && (
          <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground p-4">
            {renderEmptyState()}
          </div>
        )
      ) : (
        <PanelBody orientation={minContentWidth ? "both" : undefined}>
          {renderGroupedContent()}
        </PanelBody>
      )}

      {/* Group context menu */}
      {contextMenu && (
        <ContextMenu x={contextMenu.x} y={contextMenu.y} onClose={closeContextMenu}>
          <ContextMenuItem onClick={() => onEnableGroup(contextMenu.data.groupName, true)}>
            Enable All
          </ContextMenuItem>
          <ContextMenuItem onClick={() => onEnableGroup(contextMenu.data.groupName, false)}>
            Disable All
          </ContextMenuItem>
          <ContextMenuItem onClick={() => startGroupRename(contextMenu.data.groupName)}>
            Rename Group
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            destructive
            onClick={() => {
              const groupItems = items.filter((i) => i.group === contextMenu.data.groupName);
              onDeleteGroup(groupItems.map((i) => i.id));
            }}
          >
            Remove Group
          </ContextMenuItem>
        </ContextMenu>
      )}
    </>
  );
}
