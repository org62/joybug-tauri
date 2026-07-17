import React, { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuSeparator,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";

export interface DockWindowsMenuTab {
  id: string;
  label: string;
  shortcut?: string;
}

interface DockWindowsMenuProps {
  dockingRef: React.RefObject<{
    getActiveTabs?: () => string[];
    toggleTab?: (tabId: string) => void;
    resetLayout?: () => void;
  } | null>;
  tabs: DockWindowsMenuTab[];
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
 * plus Reset Layout. Owns its checked state — read from the dock when the menu
 * opens and re-read after every toggle — so the ticks stay correct without
 * relying on the host page re-rendering. The menu stays open across toggles so
 * the tick update is visible. Shared by the session view and the PE viewer.
 */
export function DockWindowsMenu({ dockingRef, tabs, onToggleTab, onResetLayout, children }: DockWindowsMenuProps) {
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

  return (
    <DropdownMenu onOpenChange={(open) => { if (open) refresh(); }}>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm">Windows</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[220px]">
        {tabs.map((t) => (
          <DropdownMenuCheckboxItem
            key={t.id}
            checked={activeTabs.has(t.id)}
            onSelect={(e: Event) => e.preventDefault()}
            onCheckedChange={() => toggle(t.id)}
          >
            <span className="flex-1">{t.label}</span>
            {t.shortcut && <span className="ml-auto text-xs text-muted-foreground">{t.shortcut}</span>}
          </DropdownMenuCheckboxItem>
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
