import React, { useCallback, useMemo, useState } from "react";
import { InlineEditInput } from "@/components/ui/inline-edit-input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import type { ModuleExtraInfo, ImageSectionHeader } from "@/hooks/useModuleInfo";
import { PeMapping, AddrMode, AddrTriple } from "@/lib/peAddress";
import {
  DLL_CHARACTERISTICS_FLAGS, SECTION_CHARACTERISTICS_FLAGS, FILE_CHARACTERISTICS_FLAGS,
  MACHINE_VALUES, SUBSYSTEM_VALUES, MAGIC_VALUES, DATA_DIRECTORY_NAMES,
  EnumValue, decodeSectionName, formatTimestamp, hex, hexBig, ptrHexWidth,
} from "@/lib/peDecode";
import {
  Addr, ExceptionGroup, ExpandContext, ExportsGroup, FlagsEditor, GroupRow, ImportsGroup, LeafRow,
  SelectFieldContext, SetField, TlsCallbacksGroup, TreeNav, TreeNavContext,
} from "@/components/pe/structureTree";
import { ElfStructureTree } from "@/components/pe/ElfStructureTree";

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
  /** Offer "Xrefs" in every address popover (PE viewer: the Xrefs tab). */
  onShowXrefs?: (triple: AddrTriple) => void;
}

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

// ---- Main tree ----

// The structure tree for either format. An ELF module carries its native
// headers in `info.elf` and gets the ELF tree; the PE-shaped fields it also
// carries only drive the address mapping and the shared collections.
const PeStructureTreeImpl: React.FC<PeStructureTreeProps> = ({
  info, mapping, mode, scrollRef, onGoToHex, onGoToDisasm, hexLabel, onSetField, onSelectField, onShowXrefs,
}) => {
  const nav = useMemo<TreeNav>(
    () => ({ mapping, mode, hexLabel, onGoToHex, onGoToDisasm, onShowXrefs }),
    [mapping, mode, hexLabel, onGoToHex, onGoToDisasm, onShowXrefs],
  );
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(info.elf ? ["elf", "phdrs", "sections"] : ["nt", "opt", "sections"]),
  );
  const toggle = useCallback((id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    }), []);
  const expandCtx = useMemo(() => ({ expanded, toggle }), [expanded, toggle]);

  return (
    <TreeNavContext.Provider value={nav}>
    <SelectFieldContext.Provider value={onSelectField ?? null}>
    <ExpandContext.Provider value={expandCtx}>
    <div className="text-xs">
      {info.elf
        ? <ElfStructureTree info={info} elf={info.elf} scrollRef={scrollRef} />
        : <PeTree info={info} scrollRef={scrollRef} onSetField={onSetField} />}
    </div>
    </ExpandContext.Provider>
    </SelectFieldContext.Provider>
    </TreeNavContext.Provider>
  );
};

const PeTree: React.FC<{
  info: ModuleExtraInfo; scrollRef: React.RefObject<HTMLDivElement | null>; onSetField?: SetField;
}> = ({ info, scrollRef, onSetField }) => {
  const dos = info.dos_header;
  const fh = info.nt_headers.FileHeader;
  const oh = info.nt_headers.OptionalHeader;
  const ptrWidth = ptrHexWidth(oh);

  return (
    <>
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
    </>
  );
};

// The session host re-renders on every debug event while `info`/`mapping` stay
// identity-stable, so memoizing keeps stepping from rebuilding the whole tree.
export const PeStructureTree = React.memo(PeStructureTreeImpl);
