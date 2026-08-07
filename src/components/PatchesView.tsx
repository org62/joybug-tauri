import { useState, useCallback } from "react";
import { Button } from "./ui/button";
import { Switch } from "./ui/switch";
import { Checkbox } from "./ui/checkbox";
import { X, Puzzle } from "lucide-react";
import { cn, LINK_VALUE_CLASS } from "@/lib/utils";
import type { Patch } from "@/hooks/usePatches";
import { useContextMenu } from "@/hooks/useContextMenu";
import { GroupedItemList } from "./GroupedItemList";
import { DockPanel, PanelToolbar } from "./ui/panel";
import { ContextMenu, ContextMenuItem, ContextMenuSeparator } from "./ui/context-menu";

interface PatchesViewProps {
  patches: Patch[];
  onUndoPatch?: (patchId: string) => void;
  onUndoPatches?: (patchIds: string[]) => void;
  onEnablePatch?: (patchId: string, enabled: boolean) => void;
  onUpdatePatch?: (patchId: string, group?: string) => void;
  onEnablePatchGroup?: (group: string, enabled: boolean) => void;
  onNavigateToDisassembly?: (address: string) => void;
}

export function PatchesView({
  patches,
  onUndoPatch,
  onUndoPatches,
  onEnablePatch,
  onUpdatePatch,
  onEnablePatchGroup,
  onNavigateToDisassembly,
}: PatchesViewProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const { contextMenu, openContextMenu, closeContextMenu } = useContextMenu<{
    patchId: string;
  }>();

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    setSelectedIds(prev => {
      if (prev.size === patches.length) return new Set();
      return new Set(patches.map(p => p.id));
    });
  }, [patches]);

  const handleUndoSelected = useCallback(() => {
    if (selectedIds.size === 0 || !onUndoPatches) return;
    onUndoPatches(Array.from(selectedIds));
    setSelectedIds(new Set());
  }, [selectedIds, onUndoPatches]);

  const generateNewGroupName = useCallback(() => {
    let name = "New Group";
    let counter = 2;
    const existingGroups = new Set(patches.map((p) => p.group).filter(Boolean));
    while (existingGroups.has(name)) {
      name = `New Group ${counter}`;
      counter++;
    }
    return name;
  }, [patches]);

  const allSelected = patches.length > 0 && selectedIds.size === patches.length;

  const renderPatchRow = (patch: Patch, isDragOverlay?: boolean) => (
    <div
      className={cn(
        "flex items-center px-2 py-1 text-xs font-mono hover:bg-muted/30 group",
        selectedIds.has(patch.id) && "bg-accent/30",
        !patch.enabled && "opacity-50",
        isDragOverlay && "bg-popover border rounded shadow-md",
      )}
      onContextMenu={(e) => { if (!isDragOverlay) openContextMenu(e, { patchId: patch.id }); }}
    >
      <span className="w-6 shrink-0 flex items-center justify-center">
        <Checkbox
          checked={selectedIds.has(patch.id)}
          onCheckedChange={() => toggleSelect(patch.id)}
        />
      </span>
      <span
        className={cn("w-28 shrink-0 truncate", LINK_VALUE_CLASS)}
        title={patch.address}
        onClick={() => onNavigateToDisassembly?.(patch.address)}
      >
        {patch.address}
      </span>
      <span className="w-28 shrink-0 truncate text-muted-foreground" title={`${patch.module_name}+${patch.module_offset}`}>
        {patch.module_name}+{patch.module_offset}
      </span>
      <span className="flex-1 min-w-0 truncate" title={`${patch.original_disassembly} → ${patch.assembly_text}`}>
        <span className="text-muted-foreground">{patch.original_disassembly}</span>
        <span className="text-muted-foreground/60 mx-1">&rarr;</span>
        <span className="text-syn-patched">{patch.assembly_text}</span>
      </span>
      <span className="w-14 shrink-0 flex items-center justify-center">
        <Switch
          size="xs"
          checked={patch.enabled}
          onCheckedChange={(checked) => onEnablePatch?.(patch.id, checked)}
        />
      </span>
      {!isDragOverlay && (
        <span className="w-8 shrink-0 flex items-center justify-center">
          <Button
            variant="ghost"
            size="icon-xs"
            className="opacity-0 group-hover:opacity-100 transition-opacity"
            onClick={() => onUndoPatch?.(patch.id)}
            title="Undo patch"
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
        items={patches}
        onUpdateItemGroup={(id, group) => onUpdatePatch?.(id, group)}
        onEnableGroup={(group, enabled) => onEnablePatchGroup?.(group, enabled)}
        onDeleteGroup={(ids) => onUndoPatches?.(ids)}
        renderItem={renderPatchRow}
        groupDotColor="purple"
        renderToolbar={() => (
          <>
            <PanelToolbar>
              <Button
                variant="outline"
                size="xs"
                disabled={selectedIds.size === 0}
                onClick={handleUndoSelected}
              >
                Undo Selected ({selectedIds.size})
              </Button>
              <div className="flex-1" />
              <span className="text-xs text-muted-foreground">{patches.length} patch{patches.length !== 1 ? 'es' : ''}</span>
            </PanelToolbar>
            {patches.length > 0 && (
              <div className="flex items-center px-2 py-1 border-b border-border text-xs text-muted-foreground font-medium shrink-0">
                <span className="w-6 shrink-0 flex items-center justify-center">
                  <Checkbox
                    checked={allSelected}
                    onCheckedChange={toggleSelectAll}
                  />
                </span>
                <span className="w-28 shrink-0">Address</span>
                <span className="w-28 shrink-0">Module</span>
                <span className="flex-1 min-w-0">Original &rarr; Patched</span>
                <span className="w-14 shrink-0 text-center">Enabled</span>
                <span className="w-8 shrink-0" />
              </div>
            )}
          </>
        )}
        renderEmptyState={() => (
          <>
            <Puzzle className="h-12 w-12 mx-auto mb-4 opacity-50" />
            <p className="text-base font-medium">No user patches</p>
            <p className="text-sm mt-1">Right-click an instruction in the disassembly view and select "Assemble..." to create a patch</p>
          </>
        )}
      />

      {contextMenu && (() => {
        const patch = patches.find((p) => p.id === contextMenu.data.patchId);
        return (
          <ContextMenu x={contextMenu.x} y={contextMenu.y} onClose={closeContextMenu}>
            <ContextMenuItem
              onClick={() => {
                if (patch) onEnablePatch?.(patch.id, !patch.enabled);
              }}
            >
              {patch?.enabled ? "Disable" : "Enable"}
            </ContextMenuItem>
            <ContextMenuItem
              onClick={() => {
                if (!patch) return;
                const name = generateNewGroupName();
                onUpdatePatch?.(patch.id, name);
              }}
            >
              Set Group
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem
              destructive
              onClick={() => onUndoPatch?.(contextMenu.data.patchId)}
            >
              Undo Patch
            </ContextMenuItem>
          </ContextMenu>
        );
      })()}
    </DockPanel>
  );
}
