import React, { createContext, useCallback, useContext, useMemo, useState } from "react";
import { ChevronRight, ChevronDown } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { InlineEditInput } from "@/components/ui/inline-edit-input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { TruncatedSymbol } from "@/components/ui/truncated-symbol";
import { useInlineVirtualizer } from "@/hooks/useInlineVirtualizer";
import { PeAddressLink } from "@/components/pe/AddressPopover";
import type { ModuleExtraInfo, ImageSectionHeader } from "@/hooks/useModuleInfo";
import { PeMapping, AddrMode, AddrTriple, addrForRva } from "@/lib/peAddress";
import {
  DLL_CHARACTERISTICS_FLAGS, SECTION_CHARACTERISTICS_FLAGS, FILE_CHARACTERISTICS_FLAGS,
  MACHINE_VALUES, SUBSYSTEM_VALUES, MAGIC_VALUES, DATA_DIRECTORY_NAMES,
  EnumValue, FlagBit, decodeFlags, decodeSectionName, flattenImports, formatTimestamp,
  getExportForwardTarget, getExportRva, hex, hexBig, ptrHexWidth, visibleImportRows,
} from "@/lib/peDecode";

/** Narrowest width the tree lays out at; below it the hosting PanelBody
 *  scrolls horizontally (`minContentWidth`) instead of wrapping rows. */
export const PE_TREE_MIN_WIDTH = "560px";

export interface PeStructureTreeProps {
  info: ModuleExtraInfo;
  mapping: PeMapping;
  mode: AddrMode;
  /** The enclosing PanelBody viewport — the big groups virtualize against it. */
  scrollRef: React.RefObject<HTMLDivElement | null>;
  /** Jump to an address in the data view (hex for a file, memory for a process). */
  onGoToHex: (triple: AddrTriple) => void;
  /** Jump to an address in the disassembly view. */
  onGoToDisasm: (triple: AddrTriple) => void;
  /** Label of the data-view action in address popovers (default "Hex"). */
  hexLabel?: string;
  /** Omit both editing callbacks for a read-only tree (no inline editing, no
   *  field-byte selection) — that is how a live process module is viewed. */
  onSetField?: (field: string, value: number) => void;
  /** Select the raw bytes of the given header fields in the hex view. */
  onSelectField?: (...fields: string[]) => void;
}

// Clicking a field label selects that field's bytes in the hex view; context
// so every leaf row doesn't need the handler threaded through its props.
// Null when the host can't select bytes (read-only process view).
const SelectFieldContext = createContext<((...fields: string[]) => void) | null>(null);

// Address navigation + display settings, shared by every address link in the
// tree instead of being threaded through the group components.
interface TreeNav {
  mapping: PeMapping;
  mode: AddrMode;
  hexLabel?: string;
  onGoToHex: (triple: AddrTriple) => void;
  onGoToDisasm: (triple: AddrTriple) => void;
}
const TreeNavContext = createContext<TreeNav | null>(null);

// An address link for an RVA, rendered per the tree's navigation context.
const Addr: React.FC<{ rva: number }> = ({ rva }) => {
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
    />
  );
};

// Group expand/collapse state, shared the same way — every GroupRow at any
// depth reads it instead of having the pair threaded through its props.
const ExpandContext = createContext<{ expanded: Set<string>; toggle: (id: string) => void }>({
  expanded: new Set(),
  toggle: () => {},
});

// ---- Tree scaffolding ----

const INDENT = 14;

const Caret: React.FC<{ open: boolean }> = ({ open }) =>
  open ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />;

const GroupRow: React.FC<{
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

const LeafRow: React.FC<{
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

// ---- Editors ----

type NumFormat = "hex" | "hexbig" | "dec";

// `width` sizes "hexbig" fields to the image's pointer width (8 digits for
// PE32, 16 for PE32+) so a 32-bit ImageBase doesn't render with 8 leading zeros.
const fmtNum = (v: number, format: NumFormat, width?: number): string =>
  format === "dec" ? String(v) : format === "hexbig" ? hexBig(v, width) : hex(v);

// Parse a hex (0x…) or decimal integer; null if not a valid non-negative number.
const parseNum = (text: string): number | null => {
  const t = text.trim();
  if (!t) return null;
  const n = /^0x/i.test(t) ? Number.parseInt(t.slice(2), 16) : Number.parseInt(t, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

type SetField = (field: string, value: number) => void;

// Double-click-to-edit leaf: the caller supplies the display value and how to
// commit the edited text. Owns the edit/draft state shared by all editors.
// Without `onCommit` (read-only tree) it's a plain value row.
const EditableLeaf: React.FC<{
  label: string; depth: number; display: React.ReactNode; initialText: string;
  field?: string | string[];
  editTitle?: string; inputClassName?: string; onCommit?: (text: string) => void;
}> = ({ label, depth, display, initialText, field, editTitle = "Double-click to edit", inputClassName, onCommit }) => {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");

  if (!onCommit) return <LeafRow label={label} depth={depth} field={field}>{display}</LeafRow>;
  return (
    <LeafRow label={label} depth={depth} field={field}>
      {editing ? (
        <InlineEditInput
          value={text}
          onChange={setText}
          onCommit={() => { onCommit(text); setEditing(false); }}
          onCancel={() => setEditing(false)}
          className={inputClassName}
        />
      ) : (
        <span
          className="cursor-text hover:bg-muted/40 rounded px-1 -mx-1"
          title={editTitle}
          onDoubleClick={() => { setText(initialText); setEditing(true); }}
        >
          {display}
        </span>
      )}
    </LeafRow>
  );
};

// A numeric header field: shows the formatted value, double-click to edit inline.
const NumLeaf: React.FC<{
  label: string; depth: number; field: string; value: number; format: NumFormat;
  width?: number; display?: React.ReactNode; onSetField?: SetField;
}> = ({ label, depth, field, value, format, width, display, onSetField }) => (
  <EditableLeaf
    label={label} depth={depth} field={field}
    display={display ?? fmtNum(value, format, width)}
    initialText={fmtNum(value, format, width)}
    inputClassName="w-40 font-mono"
    onCommit={onSetField && ((text) => {
      const n = parseNum(text);
      if (n !== null && n !== value) onSetField(field, n);
    })}
  />
);

// A "Major.Minor" version pair edited as one field, writing both halves.
const VersionLeaf: React.FC<{
  label: string; depth: number; majorField: string; minorField: string;
  major: number; minor: number; onSetField?: SetField;
}> = ({ label, depth, majorField, minorField, major, minor, onSetField }) => (
  <EditableLeaf
    label={label} depth={depth} field={[majorField, minorField]}
    display={`${major}.${minor}`}
    initialText={`${major}.${minor}`}
    editTitle="Double-click to edit (major.minor)"
    inputClassName="w-24 font-mono"
    onCommit={onSetField && ((text) => {
      const [a, b] = text.split(".");
      const ma = parseNum(a ?? "");
      const mi = parseNum(b ?? "0");
      if (ma !== null && ma !== major) onSetField(majorField, ma);
      if (mi !== null && mi !== minor) onSetField(minorField, mi);
    })}
  />
);

// "Name (0xNN)" — the one spelling of an enum value, used by the read-only
// rendering and by every option of the editable one.
const EnumText: React.FC<{ label: string; value: number }> = ({ label, value }) => (
  <>{label} <span className="text-muted-foreground">(0x{value.toString(16)})</span></>
);

// Enum field: a select when editable, otherwise the decoded label.
const EnumEditor: React.FC<{ value: number; values: EnumValue[]; onChange?: (v: number) => void }> = ({ value, values, onChange }) => {
  if (!onChange) {
    return <span><EnumText label={values.find((v) => v.value === value)?.label ?? "Unknown"} value={value} /></span>;
  }
  const known = values.some((v) => v.value === value);
  return (
    <Select value={String(value)} onValueChange={(v) => onChange(Number(v))}>
      <SelectTrigger size="xs" className="w-56"><SelectValue /></SelectTrigger>
      <SelectContent>
        {!known && (
          <SelectItem value={String(value)} className="text-xs"><EnumText label="Unknown" value={value} /></SelectItem>
        )}
        {values.map((v) => (
          <SelectItem key={v.value} value={String(v.value)} className="text-xs">
            <EnumText label={v.label} value={v.value} />
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};

// An enum header field, mirroring NumLeaf/VersionLeaf: the call site names the
// field once and the read-only guard lives here, not at every call site.
const EnumLeaf: React.FC<{
  label: string; depth: number; field: string; value: number; values: EnumValue[];
  onSetField?: SetField;
}> = ({ label, depth, field, value, values, onSetField }) => (
  <LeafRow label={label} depth={depth} field={field}>
    <EnumEditor value={value} values={values} onChange={onSetField && ((v) => onSetField(field, v))} />
  </LeafRow>
);

const FlagsEditor: React.FC<{
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

// ---- Main tree ----

const PeStructureTreeImpl: React.FC<PeStructureTreeProps> = ({
  info, mapping, mode, scrollRef, onGoToHex, onGoToDisasm, hexLabel, onSetField, onSelectField,
}) => {
  const nav = useMemo<TreeNav>(
    () => ({ mapping, mode, hexLabel, onGoToHex, onGoToDisasm }),
    [mapping, mode, hexLabel, onGoToHex, onGoToDisasm],
  );
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(["nt", "opt", "sections"]));
  const toggle = useCallback((id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    }), []);
  const expandCtx = useMemo(() => ({ expanded, toggle }), [expanded, toggle]);

  const dos = info.dos_header;
  const fh = info.nt_headers.FileHeader;
  const oh = info.nt_headers.OptionalHeader;
  const ptrWidth = ptrHexWidth(oh);

  return (
    <TreeNavContext.Provider value={nav}>
    <SelectFieldContext.Provider value={onSelectField ?? null}>
    <ExpandContext.Provider value={expandCtx}>
    <div className="text-xs">
      {/* DOS Header */}
      <GroupRow id="dos" label="DOS Header" depth={0}>
        {dos && (
          <>
            <NumLeaf label="e_magic" depth={1} field="dos.e_magic" value={dos.e_magic} format="hex" display={hex(dos.e_magic, 4)} onSetField={onSetField} />
            <NumLeaf label="e_lfanew" depth={1} field="dos.e_lfanew" value={dos.e_lfanew} format="hex" onSetField={onSetField} />
          </>
        )}
      </GroupRow>

      {/* NT Headers */}
      <GroupRow id="nt" label="NT Headers" depth={0}>
        <LeafRow label="Signature" depth={1} field="nt.Signature">{hex(info.nt_headers.Signature)}</LeafRow>

        {/* File Header */}
        <GroupRow id="file" label="File Header" depth={1}>
          <EnumLeaf label="Machine" depth={2} field="file.Machine" value={fh.Machine} values={MACHINE_VALUES} onSetField={onSetField} />
          <NumLeaf label="NumberOfSections" depth={2} field="file.NumberOfSections" value={fh.NumberOfSections} format="dec" onSetField={onSetField} />
          <NumLeaf label="TimeDateStamp" depth={2} field="file.TimeDateStamp" value={fh.TimeDateStamp} format="hex" display={formatTimestamp(fh.TimeDateStamp)} onSetField={onSetField} />
          <NumLeaf label="PointerToSymbolTable" depth={2} field="file.PointerToSymbolTable" value={fh.PointerToSymbolTable} format="hex" onSetField={onSetField} />
          <NumLeaf label="NumberOfSymbols" depth={2} field="file.NumberOfSymbols" value={fh.NumberOfSymbols} format="dec" onSetField={onSetField} />
          <NumLeaf label="SizeOfOptionalHeader" depth={2} field="file.SizeOfOptionalHeader" value={fh.SizeOfOptionalHeader} format="hex" display={hex(fh.SizeOfOptionalHeader, 4)} onSetField={onSetField} />
          <FlagsEditor id="file.chars" label="Characteristics" depth={2} value={fh.Characteristics} flags={FILE_CHARACTERISTICS_FLAGS} editableField="file.Characteristics" onSetField={onSetField} />
        </GroupRow>

        {/* Optional Header */}
        <GroupRow id="opt" label="Optional Header" depth={1}>
          <EnumLeaf label="Magic" depth={2} field="opt.Magic" value={oh.Magic} values={MAGIC_VALUES} onSetField={onSetField} />
          <VersionLeaf label="LinkerVersion" depth={2} majorField="opt.MajorLinkerVersion" minorField="opt.MinorLinkerVersion" major={oh.MajorLinkerVersion} minor={oh.MinorLinkerVersion} onSetField={onSetField} />
          <NumLeaf label="SizeOfCode" depth={2} field="opt.SizeOfCode" value={oh.SizeOfCode} format="hex" onSetField={onSetField} />
          <NumLeaf label="SizeOfInitializedData" depth={2} field="opt.SizeOfInitializedData" value={oh.SizeOfInitializedData} format="hex" onSetField={onSetField} />
          <NumLeaf label="SizeOfUninitializedData" depth={2} field="opt.SizeOfUninitializedData" value={oh.SizeOfUninitializedData} format="hex" onSetField={onSetField} />
          <LeafRow label="AddressOfEntryPoint" depth={2} field="opt.AddressOfEntryPoint"><Addr rva={oh.AddressOfEntryPoint} /></LeafRow>
          <LeafRow label="BaseOfCode" depth={2} field="opt.BaseOfCode"><Addr rva={oh.BaseOfCode} /></LeafRow>
          {oh.BaseOfData != null && (
            <LeafRow label="BaseOfData" depth={2} field="opt.BaseOfData"><Addr rva={oh.BaseOfData} /></LeafRow>
          )}
          <NumLeaf label="ImageBase" depth={2} field="opt.ImageBase" value={oh.ImageBase} format="hexbig" width={ptrWidth} onSetField={onSetField} />
          <NumLeaf label="SectionAlignment" depth={2} field="opt.SectionAlignment" value={oh.SectionAlignment} format="hex" onSetField={onSetField} />
          <NumLeaf label="FileAlignment" depth={2} field="opt.FileAlignment" value={oh.FileAlignment} format="hex" onSetField={onSetField} />
          <VersionLeaf label="OSVersion" depth={2} majorField="opt.MajorOperatingSystemVersion" minorField="opt.MinorOperatingSystemVersion" major={oh.MajorOperatingSystemVersion} minor={oh.MinorOperatingSystemVersion} onSetField={onSetField} />
          <VersionLeaf label="ImageVersion" depth={2} majorField="opt.MajorImageVersion" minorField="opt.MinorImageVersion" major={oh.MajorImageVersion} minor={oh.MinorImageVersion} onSetField={onSetField} />
          <VersionLeaf label="SubsystemVersion" depth={2} majorField="opt.MajorSubsystemVersion" minorField="opt.MinorSubsystemVersion" major={oh.MajorSubsystemVersion} minor={oh.MinorSubsystemVersion} onSetField={onSetField} />
          <NumLeaf label="SizeOfImage" depth={2} field="opt.SizeOfImage" value={oh.SizeOfImage} format="hex" onSetField={onSetField} />
          <NumLeaf label="SizeOfHeaders" depth={2} field="opt.SizeOfHeaders" value={oh.SizeOfHeaders} format="hex" onSetField={onSetField} />
          <NumLeaf label="CheckSum" depth={2} field="opt.CheckSum" value={oh.CheckSum} format="hex" onSetField={onSetField} />
          <EnumLeaf label="Subsystem" depth={2} field="opt.Subsystem" value={oh.Subsystem} values={SUBSYSTEM_VALUES} onSetField={onSetField} />
          <FlagsEditor id="opt.dllchars" label="DllCharacteristics" depth={2} value={oh.DllCharacteristics} flags={DLL_CHARACTERISTICS_FLAGS} editableField="opt.DllCharacteristics" onSetField={onSetField} />
          <NumLeaf label="SizeOfStackReserve" depth={2} field="opt.SizeOfStackReserve" value={oh.SizeOfStackReserve} format="hexbig" width={ptrWidth} onSetField={onSetField} />
          <NumLeaf label="SizeOfStackCommit" depth={2} field="opt.SizeOfStackCommit" value={oh.SizeOfStackCommit} format="hexbig" width={ptrWidth} onSetField={onSetField} />
          <NumLeaf label="SizeOfHeapReserve" depth={2} field="opt.SizeOfHeapReserve" value={oh.SizeOfHeapReserve} format="hexbig" width={ptrWidth} onSetField={onSetField} />
          <NumLeaf label="SizeOfHeapCommit" depth={2} field="opt.SizeOfHeapCommit" value={oh.SizeOfHeapCommit} format="hexbig" width={ptrWidth} onSetField={onSetField} />
          <NumLeaf label="NumberOfRvaAndSizes" depth={2} field="opt.NumberOfRvaAndSizes" value={oh.NumberOfRvaAndSizes} format="dec" onSetField={onSetField} />

          {/* Data Directories */}
          <GroupRow id="datadirs" label="Data Directories" depth={2}            count={oh.DataDirectory.filter((d) => d.VirtualAddress || d.Size).length}>
            {oh.DataDirectory.map((d, i) =>
              (d.VirtualAddress || d.Size) ? (
                <LeafRow key={i} label={DATA_DIRECTORY_NAMES[i] ?? `#${i}`} depth={3} field={`datadir.${i}`}>
                  <Addr rva={d.VirtualAddress} /> <span className="text-muted-foreground">size {hex(d.Size)}</span>
                </LeafRow>
              ) : null,
            )}
          </GroupRow>
        </GroupRow>
      </GroupRow>

      {/* Sections */}
      <GroupRow id="sections" label="Sections" depth={0} count={info.sections.length}>
        {info.sections.map((s: ImageSectionHeader, i) => (
          <GroupRow key={i} id={`sec.${i}`} label={decodeSectionName(s.Name) || `#${i}`} depth={1}>
            <LeafRow label="VirtualAddress" depth={2} field={`section.${i}.VirtualAddress`}><Addr rva={s.VirtualAddress} /></LeafRow>
            <NumLeaf label="VirtualSize" depth={2} field={`section.${i}.VirtualSize`} value={s.VirtualSize} format="hex" onSetField={onSetField} />
            <NumLeaf label="SizeOfRawData" depth={2} field={`section.${i}.SizeOfRawData`} value={s.SizeOfRawData} format="hex" onSetField={onSetField} />
            <NumLeaf label="PointerToRawData" depth={2} field={`section.${i}.PointerToRawData`} value={s.PointerToRawData} format="hex" onSetField={onSetField} />
            <FlagsEditor id={`sec.${i}.chars`} label="Characteristics" depth={2} value={s.Characteristics} flags={SECTION_CHARACTERISTICS_FLAGS} editableField={`section.${i}.Characteristics`} onSetField={onSetField} />
          </GroupRow>
        ))}
      </GroupRow>

      {/* Imports / Exports / Exception — inline-virtualized collections */}
      <ImportsGroup info={info} scrollRef={scrollRef} />
      <ExportsGroup info={info} scrollRef={scrollRef} />
      <TlsCallbacksGroup info={info} />
      <ExceptionGroup info={info} scrollRef={scrollRef} />
    </div>
    </ExpandContext.Provider>
    </SelectFieldContext.Provider>
    </TreeNavContext.Provider>
  );
};

// The session host re-renders on every debug event while `info`/`mapping` stay
// identity-stable, so memoizing keeps stepping from rebuilding the whole tree.
export const PeStructureTree = React.memo(PeStructureTreeImpl);

const ROW_H = 22;

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

const ImportsGroup: React.FC<GroupState & { info: ModuleExtraInfo }> =
  ({ info, scrollRef }) => {
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
      <VirtualGroup id="imports" label="Imports" count={entryCount} items={visibleRows} scrollRef={scrollRef} renderRow={(row) =>
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

const ExportsGroup: React.FC<GroupState & { info: ModuleExtraInfo }> =
  ({ info, scrollRef }) => {
    const entries = info.exports?.entries ?? [];

    if (!info.exports) return null;
    return (
      <VirtualGroup id="exports" label={`Exports — ${info.exports.dll_name}`} count={entries.length} items={entries} scrollRef={scrollRef} renderRow={(e) => {
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
const TlsCallbacksGroup: React.FC<{ info: ModuleExtraInfo }> = ({ info }) => {
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

const ExceptionGroup: React.FC<GroupState & { info: ModuleExtraInfo }> =
  ({ info, scrollRef }) => {
    const rf = info.runtime_functions;
    if (!rf || !rf.length) return null;
    return (
      <VirtualGroup id="exception" label="Exception (Runtime Functions)" count={rf.length} items={rf} scrollRef={scrollRef} renderRow={(f) => (
        <div className="flex items-center gap-3 text-xs" style={{ height: ROW_H }}>
          <Addr rva={f.BeginAddress} />
          <span className="text-muted-foreground font-mono">end {hex(f.EndAddress)}</span>
          <span className="text-muted-foreground font-mono">unwind {hex(f.UnwindData)}</span>
        </div>
      )} />
    );
  };
