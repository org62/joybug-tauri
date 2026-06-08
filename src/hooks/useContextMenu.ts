import { useState, useEffect, useRef, useCallback } from 'react';

export interface ContextMenuState<T = Record<string, unknown>> {
  x: number;
  y: number;
  data: T;
}

/**
 * Manages a right-click context menu: state, ref for the menu DOM element,
 * auto-close on outside click, and open/close helpers.
 */
export function useContextMenu<T = Record<string, unknown>>() {
  const [contextMenu, setContextMenu] = useState<ContextMenuState<T> | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (contextMenu) {
      const handleMouseDown = (e: globalThis.MouseEvent) => {
        if (contextMenuRef.current && contextMenuRef.current.contains(e.target as Node)) return;
        setContextMenu(null);
      };
      const handleKeyDown = (e: globalThis.KeyboardEvent) => {
        if (e.key === 'Escape') setContextMenu(null);
      };
      document.addEventListener('mousedown', handleMouseDown);
      document.addEventListener('keydown', handleKeyDown);
      return () => {
        document.removeEventListener('mousedown', handleMouseDown);
        document.removeEventListener('keydown', handleKeyDown);
      };
    }
  }, [contextMenu]);

  const openContextMenu = useCallback((e: React.MouseEvent, data: T) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, data });
  }, []);

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  return { contextMenu, contextMenuRef, openContextMenu, closeContextMenu };
}
