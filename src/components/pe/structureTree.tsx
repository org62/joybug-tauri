// The structure-tree scaffolding shared by the PE and ELF trees: the row
// primitives, the navigation / selection / expand contexts every row reads
// instead of having them threaded through props, and the format-agnostic
// collections (imports, exports, TLS callbacks, function table) that both
// formats fill in.

import React, { createContext, useContext, useMemo, useState } from "react";
import { ChevronRight, ChevronDown } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { TruncatedSymbol } from "@/components/ui/truncated-symbol";
import { useInlineVirtualizer } from "@/hooks/useInlineVirtualizer";
import { PeAddressLink } from "@/components/pe/AddressPopover";
import type { ModuleExtraInfo } from "@/hooks/useModuleInfo";
import { PeMapping, AddrMode, AddrTriple, addrForRva } from "@/lib/peAddress";
import {
  FlagBit, decodeFlags, flattenImports, getExportForwardTarget, getExportRva, hex, visibleImportRows,
} from "@/lib/peDecode";

export type SetField = (field: string, value: number) => void;

// Clicking a field label selects that field's bytes in the hex view; context
// so every leaf row doesn't need the handler threaded through its props.
// Null when the host can't select bytes (read-only process view).
export const SelectFieldContext = createContext<((...fields: string[]) => void) | null>(null);

// Address navigation + display settings, shared by every address link in the
// tree instead of being threaded through the group components.
export interface TreeNav {
  mapping: PeMapping;
  mode: AddrMode;
  hexLabel?: string;
  onGoToHex: (triple: AddrTriple) => void;
  onGoToDisasm: (triple: AddrTriple) => void;
  onShowXrefs?: (triple: AddrTriple) => void;
}
export const TreeNavContext = createContext<TreeNav | null>(null);

// An address link for an RVA, rendered per the tree's navigation context.
export const Addr: React.FC<{ rva: number }> = ({ rva }) => {
  const nav = useContext(TreeNavContext)!;
  // Stable identity per (mapping, rva) — the popover memoizes on the triple.
  const { triple, isCode } = useMemo(() => addrForRva(nav.mapping, rva), [nav.mapping, rva]);
  return (
    <PeAddressLink
      triple={triple}
      mode={nav.mode}
      isCode={isCode}
      hexLabel={nav.hexLabel}
      onGoToHex={nav.onGoToHex}
      onGoToDisasm={nav.onGoToDisasm}
      onShowXrefs={nav.onShowXrefs}
    />
  );
};

// Group expand/collapse state, shared the same way — every GroupRow at any
// depth reads it instead of having the pair threaded through its props.
export const ExpandContext = createContext<{ expanded: Set<string>; toggle: (id: string) => void }>({
  expanded: new Set(),
  toggle: () => {},
});

// ---- Tree scaffolding ----

export const INDENT = 14;

export const Caret: React.FC<{ open: boolean }> = ({ open }) =>
  open ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />;

export const GroupRow: React.FC<{
  id: string; label: React.ReactNode; depth: number; count?: number;
  children: React.ReactNode;
}> = ({ id, label, depth, count, children }) => {
  const { expanded, toggle } = useContext(ExpandContext);
  const open = expanded.has(id);
  return (
    <>
      <div
        className="flex items-center gap-1 py-0.5 pr-2 hover:bg-muted/40 cursor-pointer select-none text-xs"
        style={{ paddingLeft: depth * INDENT + 4 }}
        onClick={() => toggle(id)}
      >
        <Caret open={open} />
        <span className="font-medium">{label}</span>
        {count !== undefined && <span className="text-muted-foreground">({count})</span>}
      </div>
      {open && children}
    </>
  );
};

export const LeafRow: React.FC<{
  label: string; depth: number;
  /** Field name(s) whose bytes a label click selects in the hex view. */
  field?: string | string[];
  children: React.ReactNode;
}> = ({ label, depth, field, children }) => {
  const selectField = useContext(SelectFieldContext);
  const selectable = !!field && !!selectField;
  return (
    <div data-testid="pe-leaf" data-label={label} className="flex items-center gap-2 py-0.5 pr-2 text-xs" style={{ paddingLeft: depth * INDENT + 22 }}>
      <span
        className={`text-muted-foreground min-w-[180px] ${selectable ? "cursor-pointer hover:text-syn-link hover:underline decoration-dotted underline-offset-2" : ""}`}
        title={selectable ? "Click to select this field's bytes in the hex view" : undefined}
        onClick={selectable ? () => selectField(...(Array.isArray(field) ? field : [field])) : undefined}
      >
        {label}
      </span>
      <span className="font-mono break-all">{children}</span>
    </div>
  );
};

export const FlagsEditor: React.FC<{
  id: string; label: string; depth: number; value: number; flags: FlagBit[];
  editableField?: string;
  onSetField?: SetField;
}> = ({ id, label, depth, value, flags, editableField, onSetField }) => (
  <GroupRow
    id={id} depth={depth}
    label={<span>{label} <span className="font-mono text-muted-foreground font-normal">= {hex(value, 4)} {decodeFlags(flags, value)}</span></span>}
  >
    {flags.map((f) => {
      const on = (value & f.bit) !== 0;
      const editable = !!editableField && !!onSetField;
      return (
        <div key={f.bit} className="flex items-center gap-2 py-0.5 text-xs" style={{ paddingLeft: (depth + 1) * INDENT + 22 }}>
          <Checkbox
            checked={on}
            disabled={!editable}
            onCheckedChange={editable ? () => onSetField(editableField, (value ^ f.bit) >>> 0) : undefined}
          />
          <span className="font-mono">{f.name}</span>
          <span className="text-muted-foreground">0x{f.bit.toString(16)}</span>
        </div>
      );
    })}
  </GroupRow>
);

export const ROW_H = 22;

type GroupState = { scrollRef: React.RefObject<HTMLDivElement | null> };

// Top-level collapsible group whose rows virtualize inline against the panel's
// outer scroll container (imports/exports/exception can have thousands of rows).
// No nested scroll region: the group grows to its content and the panel scrolls.
function VirtualGroup<T>({ id, label, count, items, scrollRef, renderRow }: GroupState & {
  id: string; label: React.ReactNode; count: number; items: T[];
  renderRow: (item: T) => React.ReactElement;
}) {
  return (
    <GroupRow id={id} label={label} depth={0} count={count}>
      {/* A separate component so the virtualizer only exists while the group is
          open: a collapsed one must not build rows or subscribe to the scroll
          container — all three groups share the panel's single viewport. */}
      <VirtualRows items={items} scrollRef={scrollRef} renderRow={renderRow} />
    </GroupRow>
  );
}

function VirtualRows<T>({ items, scrollRef, renderRow }: GroupState & {
  items: T[]; renderRow: (item: T) => React.ReactElement;
}) {
  const { listRef, virtualizer, rowStyle } = useInlineVirtualizer(scrollRef, items.length, ROW_H);
  return (
    <div ref={listRef} className="relative" style={{ height: virtualizer.getTotalSize() }}>
      {virtualizer.getVirtualItems().map((v) => (
        <div key={v.index} style={{ ...rowStyle(v), paddingLeft: 22 }}>
          {renderRow(items[v.index])}
        </div>
      ))}
    </div>
  );
}

export const ImportsGroup: React.FC<GroupState & { info: ModuleExtraInfo; label?: string }> =
  ({ info, scrollRef, label = "Imports" }) => {
    const { rows, entryCount } = useMemo(() => flattenImports(info.imports), [info.imports]);
    // Individually foldable DLLs: collapsed ones keep their header row only.
    const [collapsedDlls, setCollapsedDlls] = useState<Set<number>>(new Set());
    const toggleDll = (i: number) =>
      setCollapsedDlls((prev) => {
        const next = new Set(prev);
        next.has(i) ? next.delete(i) : next.add(i);
        return next;
      });
    const visibleRows = useMemo(() => visibleImportRows(rows, collapsedDlls), [rows, collapsedDlls]);

    if (!info.imports.length) return null;
    return (
      <VirtualGroup id="imports" label={label} count={entryCount} items={visibleRows} scrollRef={scrollRef} renderRow={(row) =>
        row.kind === "dll" ? (
          <div
            data-testid="pe-import-dll"
            className="flex items-center gap-1 text-xs font-medium bg-muted/30 hover:bg-muted/50 px-1 cursor-pointer select-none"
            style={{ height: ROW_H }}
            onClick={() => toggleDll(row.dllIndex)}
          >
            <Caret open={!collapsedDlls.has(row.dllIndex)} />
            {row.dll}
            <span className="text-muted-foreground font-normal">({row.count})</span>
          </div>
        ) : (
          <div data-testid="pe-import-row" className="flex items-center gap-2 text-xs pl-3" style={{ height: ROW_H }}>
            {row.rva ? <Addr rva={row.rva} /> : <span className="text-muted-foreground">—</span>}
            <TruncatedSymbol text={row.text} className="flex-1" />
          </div>
        )
      } />
    );
  };

export const ExportsGroup: React.FC<GroupState & { info: ModuleExtraInfo; label?: string }> =
  ({ info, scrollRef, label = "Exports" }) => {
    const entries = info.exports?.entries ?? [];

    if (!info.exports) return null;
    return (
      <VirtualGroup id="exports" label={`${label} — ${info.exports.dll_name}`} count={entries.length} items={entries} scrollRef={scrollRef} renderRow={(e) => {
        const rva = getExportRva(e.kind);
        const fwd = getExportForwardTarget(e.kind);
        return (
          <div className="flex items-center gap-2 text-xs" style={{ height: ROW_H }}>
            <span className="w-12 shrink-0 font-mono">{e.ordinal}</span>
            <span className="flex-1 min-w-0 flex"><TruncatedSymbol text={e.name ?? "—"} className="flex-1" /></span>
            <span className="w-40 shrink-0">
              {rva !== null && rva !== 0 ? <Addr rva={rva} /> :
                fwd !== null ? <span className="text-muted-foreground font-mono">{fwd}</span> : <span className="text-muted-foreground">—</span>}
            </span>
          </div>
        );
      }} />
    );
  };

// TLS callbacks run before the entry point — a handful at most, so no
// virtualization; each is a code address.
export const TlsCallbacksGroup: React.FC<{ info: ModuleExtraInfo }> = ({ info }) => {
  const callbacks = info.tls_callbacks ?? [];
  if (!callbacks.length) return null;
  return (
    <GroupRow id="tls" label="TLS Callbacks" depth={0} count={callbacks.length}>
      {callbacks.map((rva, i) => (
        <LeafRow key={i} label={`Callback #${i}`} depth={1}>
          <Addr rva={rva} />
        </LeafRow>
      ))}
    </GroupRow>
  );
};

export const ExceptionGroup: React.FC<GroupState & { info: ModuleExtraInfo; label?: string }> =
  ({ info, scrollRef, label = "Exception (Runtime Functions)" }) => {
    const rf = info.runtime_functions;
    if (!rf || !rf.length) return null;
    return (
      <VirtualGroup id="exception" label={label} count={rf.length} items={rf} scrollRef={scrollRef} renderRow={(f) => (
        <div className="flex items-center gap-3 text-xs" style={{ height: ROW_H }}>
          <Addr rva={f.BeginAddress} />
          <span className="text-muted-foreground font-mono">end {hex(f.EndAddress)}</span>
          <span className="text-muted-foreground font-mono">unwind {hex(f.UnwindData)}</span>
        </div>
      )} />
    );
  };
