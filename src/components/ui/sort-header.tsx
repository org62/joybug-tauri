import { ChevronUp, ChevronDown } from "lucide-react";

/**
 * Clickable, sortable column header label for table-like views. Not a raw
 * <button> (lint forbids those in views); a span with role/onClick carries the
 * sort affordance + direction chevron.
 */
export function SortHeader({ label, active, asc, onClick }: {
  label: string; active: boolean; asc: boolean; onClick: () => void;
}) {
  return (
    <span
      role="button"
      tabIndex={0}
      className="inline-flex items-center gap-0.5 cursor-pointer select-none hover:text-foreground"
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}
    >
      {label}
      {active && (asc ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />)}
    </span>
  );
}
