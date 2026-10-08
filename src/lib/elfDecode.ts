// Symbolic decoding of ELF header fields — the names `readelf` prints for
// e_type, e_machine, program-header and section types/flags and .dynamic
// tags. Used by the ELF structure tree (read-only: ELF header edits are not
// supported).

import type { EnumValue, FlagBit } from "@/lib/peDecode";

export const ELF_CLASS_VALUES: EnumValue[] = [
  { value: 1, label: "ELF32" },
  { value: 2, label: "ELF64" },
];

export const ELF_DATA_VALUES: EnumValue[] = [
  { value: 1, label: "little endian (2's complement)" },
  { value: 2, label: "big endian (2's complement)" },
];

export const ELF_OSABI_VALUES: EnumValue[] = [
  { value: 0, label: "UNIX - System V" },
  { value: 3, label: "UNIX - GNU/Linux" },
  { value: 9, label: "UNIX - FreeBSD" },
  { value: 12, label: "UNIX - OpenBSD" },
];

export const ELF_TYPE_VALUES: EnumValue[] = [
  { value: 0, label: "NONE" },
  { value: 1, label: "REL (relocatable)" },
  { value: 2, label: "EXEC (executable)" },
  { value: 3, label: "DYN (shared object / PIE)" },
  { value: 4, label: "CORE" },
];

export const ELF_MACHINE_VALUES: EnumValue[] = [
  { value: 3, label: "x86 (Intel 80386)" },
  { value: 40, label: "ARM" },
  { value: 62, label: "x86-64 (AMD64)" },
  { value: 183, label: "AArch64" },
  { value: 243, label: "RISC-V" },
];

export const PT_VALUES: EnumValue[] = [
  { value: 0, label: "NULL" },
  { value: 1, label: "LOAD" },
  { value: 2, label: "DYNAMIC" },
  { value: 3, label: "INTERP" },
  { value: 4, label: "NOTE" },
  { value: 5, label: "SHLIB" },
  { value: 6, label: "PHDR" },
  { value: 7, label: "TLS" },
  { value: 0x6474e550, label: "GNU_EH_FRAME" },
  { value: 0x6474e551, label: "GNU_STACK" },
  { value: 0x6474e552, label: "GNU_RELRO" },
  { value: 0x6474e553, label: "GNU_PROPERTY" },
  { value: 0x6474e554, label: "GNU_SFRAME" },
];

export const PF_FLAGS: FlagBit[] = [
  { bit: 0x4, name: "R" },
  { bit: 0x2, name: "W" },
  { bit: 0x1, name: "X" },
];

export const SHT_VALUES: EnumValue[] = [
  { value: 0, label: "NULL" },
  { value: 1, label: "PROGBITS" },
  { value: 2, label: "SYMTAB" },
  { value: 3, label: "STRTAB" },
  { value: 4, label: "RELA" },
  { value: 5, label: "HASH" },
  { value: 6, label: "DYNAMIC" },
  { value: 7, label: "NOTE" },
  { value: 8, label: "NOBITS" },
  { value: 9, label: "REL" },
  { value: 10, label: "SHLIB" },
  { value: 11, label: "DYNSYM" },
  { value: 14, label: "INIT_ARRAY" },
  { value: 15, label: "FINI_ARRAY" },
  { value: 16, label: "PREINIT_ARRAY" },
  { value: 17, label: "GROUP" },
  { value: 18, label: "SYMTAB_SHNDX" },
  { value: 19, label: "RELR" },
  { value: 0x6ffffff5, label: "GNU_ATTRIBUTES" },
  { value: 0x6ffffff6, label: "GNU_HASH" },
  { value: 0x6ffffff7, label: "GNU_LIBLIST" },
  { value: 0x6ffffffd, label: "VERDEF" },
  { value: 0x6ffffffe, label: "VERNEED" },
  { value: 0x6fffffff, label: "VERSYM" },
];

export const SHF_FLAGS: FlagBit[] = [
  { bit: 0x1, name: "WRITE" },
  { bit: 0x2, name: "ALLOC" },
  { bit: 0x4, name: "EXECINSTR" },
  { bit: 0x10, name: "MERGE" },
  { bit: 0x20, name: "STRINGS" },
  { bit: 0x40, name: "INFO_LINK" },
  { bit: 0x80, name: "LINK_ORDER" },
  { bit: 0x100, name: "OS_NONCONFORMING" },
  { bit: 0x200, name: "GROUP" },
  { bit: 0x400, name: "TLS" },
  { bit: 0x800, name: "COMPRESSED" },
];

export const DT_VALUES: EnumValue[] = [
  { value: 0, label: "NULL" }, { value: 1, label: "NEEDED" }, { value: 2, label: "PLTRELSZ" }, { value: 3, label: "PLTGOT" },
  { value: 4, label: "HASH" }, { value: 5, label: "STRTAB" }, { value: 6, label: "SYMTAB" }, { value: 7, label: "RELA" },
  { value: 8, label: "RELASZ" }, { value: 9, label: "RELAENT" }, { value: 10, label: "STRSZ" }, { value: 11, label: "SYMENT" },
  { value: 12, label: "INIT" }, { value: 13, label: "FINI" }, { value: 14, label: "SONAME" }, { value: 15, label: "RPATH" },
  { value: 16, label: "SYMBOLIC" }, { value: 17, label: "REL" }, { value: 18, label: "RELSZ" }, { value: 19, label: "RELENT" },
  { value: 20, label: "PLTREL" }, { value: 21, label: "DEBUG" }, { value: 22, label: "TEXTREL" }, { value: 23, label: "JMPREL" },
  { value: 24, label: "BIND_NOW" }, { value: 25, label: "INIT_ARRAY" }, { value: 26, label: "FINI_ARRAY" },
  { value: 27, label: "INIT_ARRAYSZ" }, { value: 28, label: "FINI_ARRAYSZ" }, { value: 29, label: "RUNPATH" },
  { value: 30, label: "FLAGS" }, { value: 32, label: "PREINIT_ARRAY" }, { value: 33, label: "PREINIT_ARRAYSZ" },
  { value: 34, label: "SYMTAB_SHNDX" }, { value: 35, label: "RELRSZ" }, { value: 36, label: "RELR" }, { value: 37, label: "RELRENT" },
  { value: 0x6ffffef5, label: "GNU_HASH" }, { value: 0x6ffffff0, label: "VERSYM" }, { value: 0x6ffffff9, label: "RELACOUNT" },
  { value: 0x6ffffffa, label: "RELCOUNT" }, { value: 0x6ffffffb, label: "FLAGS_1" }, { value: 0x6ffffffc, label: "VERDEF" },
  { value: 0x6ffffffd, label: "VERDEFNUM" }, { value: 0x6ffffffe, label: "VERNEED" }, { value: 0x6fffffff, label: "VERNEEDNUM" },
];

/** `.dynamic` tags whose value is an address in the image. */
export const DT_ADDRESS_TAGS = new Set([3, 4, 5, 6, 7, 12, 13, 17, 23, 25, 26, 32, 36, 0x6ffffef5, 0x6ffffff0, 0x6ffffffc, 0x6ffffffe]);

/** "NAME" for a known value, else "0x…". */
export function elfEnumLabel(values: EnumValue[], value: number): string {
  return values.find((v) => v.value === value)?.label ?? `0x${value.toString(16)}`;
}

/** Segment flags the way readelf prints them: "R E", "RW ", ... */
export function decodePFlags(flags: number): string {
  return `${flags & 4 ? "R" : " "}${flags & 2 ? "W" : " "}${flags & 1 ? "X" : " "}`;
}
