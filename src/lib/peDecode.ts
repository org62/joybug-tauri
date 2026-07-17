// Symbolic decoding of PE header fields — flag bit names, enum values, and
// display formatters. Shared by the structure tree (read + edit) and the
// read-only ModuleInfoView.

import type { ExportKind, ImportDescriptorInfo, ImportKind, ModuleExtraInfo } from "@/hooks/useModuleInfo";

export interface FlagBit {
  bit: number;
  name: string;
  /** Compact label for dense table cells; bits without one are omitted there. */
  short?: string;
}

export interface EnumValue {
  value: number;
  label: string;
}

// IMAGE_DLLCHARACTERISTICS_*
export const DLL_CHARACTERISTICS_FLAGS: FlagBit[] = [
  { bit: 0x0020, name: "HIGH_ENTROPY_VA" },
  { bit: 0x0040, name: "DYNAMIC_BASE" },
  { bit: 0x0080, name: "FORCE_INTEGRITY" },
  { bit: 0x0100, name: "NX_COMPAT" },
  { bit: 0x0200, name: "NO_ISOLATION" },
  { bit: 0x0400, name: "NO_SEH" },
  { bit: 0x0800, name: "NO_BIND" },
  { bit: 0x1000, name: "APPCONTAINER" },
  { bit: 0x2000, name: "WDM_DRIVER" },
  { bit: 0x4000, name: "GUARD_CF" },
  { bit: 0x8000, name: "TERMINAL_SERVER_AWARE" },
];

// IMAGE_SCN_* (the commonly-toggled subset)
export const SECTION_CHARACTERISTICS_FLAGS: FlagBit[] = [
  { bit: 0x00000020, name: "CNT_CODE", short: "Code" },
  { bit: 0x00000040, name: "CNT_INITIALIZED_DATA", short: "InitData" },
  { bit: 0x00000080, name: "CNT_UNINITIALIZED_DATA", short: "UninitData" },
  { bit: 0x02000000, name: "MEM_DISCARDABLE" },
  { bit: 0x04000000, name: "MEM_NOT_CACHED" },
  { bit: 0x08000000, name: "MEM_NOT_PAGED" },
  { bit: 0x10000000, name: "MEM_SHARED" },
  { bit: 0x20000000, name: "MEM_EXECUTE", short: "X" },
  { bit: 0x40000000, name: "MEM_READ", short: "R" },
  { bit: 0x80000000, name: "MEM_WRITE", short: "W" },
];

// IMAGE_FILE_* characteristics (read-only display only for now)
export const FILE_CHARACTERISTICS_FLAGS: FlagBit[] = [
  { bit: 0x0001, name: "RELOCS_STRIPPED" },
  { bit: 0x0002, name: "EXECUTABLE_IMAGE" },
  { bit: 0x0020, name: "LARGE_ADDRESS_AWARE" },
  { bit: 0x0100, name: "32BIT_MACHINE" },
  { bit: 0x0200, name: "DEBUG_STRIPPED" },
  { bit: 0x1000, name: "SYSTEM" },
  { bit: 0x2000, name: "DLL" },
];

export const MACHINE_VALUES: EnumValue[] = [
  { value: 0x8664, label: "x64 (AMD64)" },
  { value: 0x014c, label: "x86 (I386)" },
  { value: 0xaa64, label: "ARM64" },
  { value: 0x01c0, label: "ARM" },
  { value: 0x01c4, label: "ARM Thumb-2" },
];

export const SUBSYSTEM_VALUES: EnumValue[] = [
  { value: 1, label: "Native" },
  { value: 2, label: "Windows GUI" },
  { value: 3, label: "Windows CUI" },
  { value: 5, label: "OS/2 CUI" },
  { value: 7, label: "POSIX CUI" },
  { value: 9, label: "Windows CE GUI" },
  { value: 10, label: "EFI Application" },
  { value: 11, label: "EFI Boot Service Driver" },
  { value: 12, label: "EFI Runtime Driver" },
  { value: 13, label: "EFI ROM" },
  { value: 14, label: "Xbox" },
];

export const MAGIC_VALUES: EnumValue[] = [
  { value: 0x10b, label: "PE32" },
  { value: 0x20b, label: "PE32+ (64-bit)" },
];

// The 16 IMAGE_DIRECTORY_ENTRY_* names, indexed by data-directory slot.
export const DATA_DIRECTORY_NAMES = [
  "Export", "Import", "Resource", "Exception", "Security", "Base Relocation",
  "Debug", "Architecture", "Global Ptr", "TLS", "Load Config", "Bound Import",
  "IAT", "Delay Import", "CLR Runtime", "Reserved",
];

export function enumLabel(values: EnumValue[], value: number): string {
  return values.find((v) => v.value === value)?.label ?? `Unknown (0x${value.toString(16)})`;
}

export function decodeFlags(flags: FlagBit[], value: number): string {
  const on = flags.filter((f) => (value & f.bit) !== 0).map((f) => f.name);
  return on.length ? on.join(" | ") : "(none)";
}

/** Compact variant of `decodeFlags` using the `short` labels (for table cells). */
export function decodeShortFlags(flags: FlagBit[], value: number): string {
  return flags
    .filter((f) => f.short && (value & f.bit) !== 0)
    .map((f) => f.short)
    .join(" | ");
}

export function decodeSectionName(nameBytes: number[]): string {
  return String.fromCharCode(...nameBytes.filter((b) => b !== 0));
}

export function formatTimestamp(timestamp: number): string {
  if (timestamp === 0) return "0";
  const date = new Date(timestamp * 1000);
  const year = date.getUTCFullYear();
  // Outside a sane range → likely a reproducible-build content hash, not a date.
  if (year < 1980 || year > new Date().getFullYear() + 1) {
    return `0x${timestamp.toString(16).toUpperCase()}`;
  }
  return `${date.toISOString().replace("T", " ").replace(".000Z", "")} (0x${timestamp.toString(16).toUpperCase()})`;
}

export function hex(value: number, width = 8): string {
  return `0x${(value >>> 0).toString(16).toUpperCase().padStart(width, "0")}`;
}

export function hexBig(value: number | bigint, width = 16): string {
  return `0x${BigInt(value).toString(16).toUpperCase().padStart(width, "0")}`;
}

/** Display text for one import entry (by-name, by-ordinal, or parse error). */
export function importEntryText(kind: ImportKind): string {
  if ("Item" in kind) {
    return "ByName" in kind.Item
      ? kind.Item.ByName.name
      : `#${kind.Item.ByOrdinal.ordinal} (ordinal)`;
  }
  return `<error: ${kind.Error}>`;
}

export function getExportRva(kind: ExportKind): number | null {
  return "Symbol" in kind ? kind.Symbol.rva : null;
}

export function getExportForwardTarget(kind: ExportKind): string | null {
  return "Forward" in kind ? kind.Forward.target : null;
}

/** A flattened import row: a DLL group header or a single imported symbol.
 *  `dllIndex` ties each row to its import descriptor so DLLs can fold. */
export type ImportRow =
  | { kind: "dll"; dll: string; count: number; dllIndex: number }
  | { kind: "entry"; text: string; rva: number; dllIndex: number };

/** Flatten import descriptors into dll-header + entry rows for list rendering. */
export function flattenImports(imports: ImportDescriptorInfo[]): { rows: ImportRow[]; entryCount: number } {
  const rows: ImportRow[] = [];
  let entryCount = 0;
  imports.forEach((desc, dllIndex) => {
    rows.push({ kind: "dll", dll: desc.dll_name, count: desc.entries.length, dllIndex });
    for (const e of desc.entries) {
      rows.push({ kind: "entry", text: importEntryText(e.kind), rva: e.iat_rva, dllIndex });
      entryCount++;
    }
  });
  return { rows, entryCount };
}

/** Drop entry rows belonging to collapsed DLLs (header rows always stay). */
export function visibleImportRows(rows: ImportRow[], collapsedDlls: ReadonlySet<number>): ImportRow[] {
  return collapsedDlls.size
    ? rows.filter((r) => r.kind === "dll" || !collapsedDlls.has(r.dllIndex))
    : rows;
}

/**
 * Mirror a `pe_set_field` edit into an already-parsed ModuleExtraInfo, so the
 * frontend doesn't need the backend to re-parse and re-ship the whole structure
 * per edit. The field name's suffix matches the parsed field name; the prefix
 * selects the struct: `dos.<F>`, `file.<F>`, `opt.<F>`, `section.<i>.<F>`.
 */
export function applyFieldEdit(info: ModuleExtraInfo, field: string, value: number): ModuleExtraInfo {
  const dot = field.indexOf(".");
  const scope = field.slice(0, dot);
  const rest = field.slice(dot + 1);
  const nt = info.nt_headers;
  switch (scope) {
    case "opt":
      return { ...info, nt_headers: { ...nt, OptionalHeader: { ...nt.OptionalHeader, [rest]: value } } };
    case "file":
      return { ...info, nt_headers: { ...nt, FileHeader: { ...nt.FileHeader, [rest]: value } } };
    case "dos":
      return info.dos_header ? { ...info, dos_header: { ...info.dos_header, [rest]: value } } : info;
    case "section": {
      const [idxStr, name] = rest.split(".");
      const idx = Number(idxStr);
      return { ...info, sections: info.sections.map((s, i) => (i === idx ? { ...s, [name]: value } : s)) };
    }
    default:
      return info;
  }
}
