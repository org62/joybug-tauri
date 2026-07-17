// Shared PE address model: converts between the three coordinate systems a PE
// viewer cares about — file offset, RVA (relative virtual address), and VA
// (virtual address = load base + RVA) — and formats/parses per display mode.
//
// The hex view is addressed by file offset; the disassembly view by VA. A single
// display mode (VA/RVA/file) transforms what the user sees in both, and the
// address popover shows all three for any clickable element.

import type { ModuleExtraInfo } from "@/hooks/useModuleInfo";
import { hex, hexBig } from "@/lib/peDecode";

export type AddrMode = "va" | "rva" | "file";

export const ADDR_MODE_LABELS: Record<AddrMode, string> = {
  va: "VA",
  rva: "RVA",
  file: "File offset",
};

export interface PeSectionMap {
  virtAddr: number;
  virtSize: number;
  rawPtr: number;
  rawSize: number;
  /** IMAGE_SCN_MEM_EXECUTE — the section holds code. */
  exec: boolean;
}

// IMAGE_SCN_MEM_EXECUTE
const SCN_MEM_EXECUTE = 0x20000000;

export interface PeMapping {
  base: bigint;
  sections: PeSectionMap[];
}

export interface AddrTriple {
  va: bigint;
  rva: number;
  file: number;
}

export function buildMapping(info: ModuleExtraInfo, base: bigint): PeMapping {
  return {
    base,
    sections: info.sections.map((s) => ({
      virtAddr: s.VirtualAddress,
      virtSize: s.VirtualSize,
      rawPtr: s.PointerToRawData,
      rawSize: s.SizeOfRawData,
      exec: (s.Characteristics & SCN_MEM_EXECUTE) !== 0,
    })),
  };
}

/** True when `rva` falls in an executable section (points at code, not data). */
export function rvaIsExecutable(m: PeMapping, rva: number): boolean {
  for (const s of m.sections) {
    if (rva >= s.virtAddr && rva < s.virtAddr + Math.max(s.virtSize, s.rawSize)) {
      return s.exec;
    }
  }
  return false;
}

export function rvaToOffset(m: PeMapping, rva: number): number {
  for (const s of m.sections) {
    const size = Math.max(s.virtSize, s.rawSize);
    if (rva >= s.virtAddr && rva < s.virtAddr + size) {
      return s.rawPtr + (rva - s.virtAddr);
    }
  }
  return rva; // headers / outside sections map identically
}

export function offsetToRva(m: PeMapping, offset: number): number {
  for (const s of m.sections) {
    if (s.rawSize > 0 && offset >= s.rawPtr && offset < s.rawPtr + s.rawSize) {
      return s.virtAddr + (offset - s.rawPtr);
    }
  }
  return offset;
}

export const rvaToVa = (m: PeMapping, rva: number): bigint => m.base + BigInt(rva >>> 0);
export const vaToRva = (m: PeMapping, va: bigint): number => Number(va - m.base);

export function tripleFromRva(m: PeMapping, rva: number): AddrTriple {
  return { va: rvaToVa(m, rva), rva, file: rvaToOffset(m, rva) };
}
export function tripleFromOffset(m: PeMapping, offset: number): AddrTriple {
  const rva = offsetToRva(m, offset);
  return { va: rvaToVa(m, rva), rva, file: offset };
}
export function tripleFromVa(m: PeMapping, va: bigint): AddrTriple {
  const rva = vaToRva(m, va);
  return { va, rva, file: rvaToOffset(m, rva) };
}

/** Interpret a user-typed numeric address (goto boxes). Values at or above
 * the load base are VAs regardless of display mode — a pasted VA works
 * anywhere; smaller values follow the display mode: RVA in VA/RVA modes, raw
 * file offset in file mode. */
export function tripleFromInput(m: PeMapping, value: bigint, mode: AddrMode): AddrTriple {
  if (value >= m.base) return tripleFromVa(m, value);
  if (mode === "file") return tripleFromOffset(m, Number(value));
  return tripleFromRva(m, Number(value));
}

/** Format a triple as the address string for the chosen display mode. */
export function formatAddr(t: AddrTriple, mode: AddrMode): string {
  switch (mode) {
    case "va": return hexBig(t.va, 0);
    case "rva": return hex(t.rva, 0);
    case "file": return hex(t.file, 0);
  }
}

/** Format a file offset directly (for the hex gutter, which is offset-native). */
export function formatOffset(m: PeMapping, offset: bigint, mode: AddrMode): string {
  return formatAddr(tripleFromOffset(m, Number(offset)), mode);
}

/** Format a VA directly (for the disassembly view, which is VA-native). */
export function formatVa(m: PeMapping, va: bigint, mode: AddrMode): string {
  return formatAddr(tripleFromVa(m, va), mode);
}
