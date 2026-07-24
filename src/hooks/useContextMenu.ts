import { useState, useCallback } from 'react';

export interface ContextMenuState<T = Record<string, unknown>> {
  x: number;
  y: number;
  data: T;
}

/**
 * Manages right-click context menu state (position + payload) and open/close
 * helpers. Outside-click and Escape handling live in the `<ContextMenu>`
 * primitive (`@/components/ui/context-menu`), so render the menu with that:
 *
 *   {contextMenu && (
 *     <ContextMenu x={contextMenu.x} y={contextMenu.y} onClose={closeContextMenu}>
 *       ...<ContextMenuItem />...
 *     </ContextMenu>
 *   )}
 */
export function useContextMenu<T = Record<string, unknown>>() {
  const [contextMenu, setContextMenu] = useState<ContextMenuState<T> | null>(null);

  const openContextMenu = useCallback((e: React.MouseEvent, data: T) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, data });
  }, []);

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  return { contextMenu, openContextMenu, closeContextMenu };
}
