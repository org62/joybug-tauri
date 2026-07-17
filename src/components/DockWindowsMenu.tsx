import React, { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuSeparator,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "@/components/ui/dropdown-menu";

export interface DockWindowsMenuTab {
  id: string;
  label: string;
  shortcut?: string;
}

/** A submenu of related tabs. Used when a flat list would be too long to scan. */
export interface DockWindowsMenuGroup {
  label: string;
  tabs: DockWindowsMenuTab[];
  /** Extra items rendered inside this submenu (e.g. "Add Memory Window"). */
  children?: React.ReactNode;
}

interface DockWindowsMenuProps {
  dockingRef: React.RefObject<{
    getActiveTabs?: () => string[];
    toggleTab?: (tabId: string) => void;
    resetLayout?: () => void;
  } | null>;
  /** Tabs listed flat at the top level. Hosts with few tabs use only this. */
  tabs?: DockWindowsMenuTab[];
  /** Tabs listed in submenus, after any flat `tabs`. */
  groups?: DockWindowsMenuGroup[];
  /** Override for toggling (hosts that sync extra state); defaults to the ref's toggleTab. */
  onToggleTab?: (tabId: string) => void;
  /** Override for resetting; defaults to the ref's resetLayout. */
  onResetLayout?: () => void;
  /** Extra menu items rendered between the tab list and Reset Layout. */
  children?: React.ReactNode;
}

/**
 * The "Windows" dropdown for a docked layout: one checkbox per tab (activate a
 * background tab / close an active one / re-add a closed one via toggleTab)
 * plus Reset Layout. This is the only place a window can be *closed* — the
 * palette and the keyboard chords only navigate.
 *
 * Owns its checked state — read from the dock when the menu opens and re-read
 * after every toggle — so the ticks stay correct without relying on the host
 * page re-rendering. The menu stays open across toggles so the tick update is
 * visible. Shared by the session view (grouped) and the PE viewer (flat).
 */
export function DockWindowsMenu({ dockingRef, tabs, groups, onToggleTab, onResetLayout, children }: DockWindowsMenuProps) {
  const [activeTabs, setActiveTabs] = useState<Set<string>>(new Set());

  const refresh = useCallback(() => {
    setActiveTabs(new Set(dockingRef.current?.getActiveTabs?.() ?? []));
  }, [dockingRef]);

  // Re-read on the next tick, after the dock has applied the layout change.
  const refreshSoon = () => setTimeout(refresh, 0);

  const toggle = (tabId: string) => {
    if (onToggleTab) onToggleTab(tabId);
    else dockingRef.current?.toggleTab?.(tabId);
    refreshSoon();
  };

  const reset = () => {
    if (onResetLayout) onResetLayout();
    else dockingRef.current?.resetLayout?.();
    refreshSoon();
  };

  const renderTab = (t: DockWindowsMenuTab) => (
    <DropdownMenuCheckboxItem
      key={t.id}
      checked={activeTabs.has(t.id)}
      onSelect={(e: Event) => e.preventDefault()}
      onCheckedChange={() => toggle(t.id)}
    >
      <span className="flex-1">{t.label}</span>
      {t.shortcut && <span className="ml-auto text-xs text-muted-foreground">{t.shortcut}</span>}
    </DropdownMenuCheckboxItem>
  );

  return (
    <DropdownMenu onOpenChange={(open) => { if (open) refresh(); }}>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm">Windows</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[220px]">
        {tabs?.map(renderTab)}
        {groups?.map((g) => (
          <DropdownMenuSub key={g.label}>
            <DropdownMenuSubTrigger>{g.label}</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="min-w-[220px]">
              {g.tabs.map(renderTab)}
              {g.children}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ))}
        {children}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={(e: Event) => { e.preventDefault(); reset(); }}>
          Reset Layout
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
