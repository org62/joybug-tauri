import { useState, useCallback } from "react";

const MIN_COL_WIDTH = 40;

/**
 * Resizable, localStorage-persisted column widths shared by table-like views
 * (assembly listing, bookmarks). Returns the current widths plus an
 * `onMouseDown` handler factory for a column's drag grip. Widths are clamped to
 * a sane minimum and persisted on drag end.
 */
export function useColumnWidths<K extends string>(
  storageKey: string,
  defaults: Record<K, number>,
) {
  const [columnWidths, setColumnWidths] = useState<Record<K, number>>(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        const parsed = JSON.parse(saved);
        const merged = { ...defaults };
        for (const key of Object.keys(defaults) as K[]) {
          if (typeof parsed[key] === "number") {
            merged[key] = Math.max(MIN_COL_WIDTH, parsed[key]);
          }
        }
        return merged;
      }
    } catch {
      // ignore malformed persisted value
    }
    return { ...defaults };
  });

  const handleColumnResizeStart = useCallback(
    (column: K, e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = columnWidths[column];
      const onMouseMove = (ev: MouseEvent) => {
        const delta = ev.clientX - startX;
        setColumnWidths((prev) => ({ ...prev, [column]: Math.max(MIN_COL_WIDTH, startWidth + delta) }));
      };
      const onMouseUp = () => {
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        setColumnWidths((prev) => {
          try { localStorage.setItem(storageKey, JSON.stringify(prev)); } catch { /* ignore */ }
          return prev;
        });
      };
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    },
    [columnWidths, storageKey],
  );

  return { columnWidths, setColumnWidths, handleColumnResizeStart };
}
