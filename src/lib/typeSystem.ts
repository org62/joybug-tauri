// Type-system shared types + pure value-rendering helpers.
//
// Mirrors the Rust DTOs in `commands/types.rs`. Addresses are hex strings (JS number
// precision); byte-level values are read little-endian from a struct's memory blob.

import { parseAddress } from "@/lib/hexUtils";

export type TypeClass =
  | { kind: "int" }
  | { kind: "uint" }
  | { kind: "float" }
  | { kind: "bool" }
  | { kind: "char" }
  | { kind: "wchar" }
  | { kind: "void" }
  | { kind: "pointer"; pointee: TypeRef }
  | { kind: "array"; element: TypeRef; count: number }
  | { kind: "udt"; index: number }
  | { kind: "enum"; index: number }
  | { kind: "unknown" };

export interface TypeRef {
  name: string;
  size: number;
  class: TypeClass;
}

export interface TypeMember {
  name: string;
  offset: number;
  type_ref: TypeRef;
  bit_position: number | null;
  bit_length: number | null;
  module_base: string | null;
}

export interface TypeEnumValue {
  name: string;
  value: number;
}

export interface TypeLayout {
  name: string;
  size: number;
  kind: string; // "struct" | "class" | "union" | "enum"
  index: number;
  module_base: string; // hex
  members: TypeMember[];
  enum_values: TypeEnumValue[];
  source: string; // "pdb" | "custom"
}

export interface TypeSummary {
  name: string;
  size: number;
  kind: string;
  index: number;
  module_base: string;
  module_name: string;
  source: string;
}

export interface CustomFieldDef {
  name: string;
  type_expr: string;
  offset: number | null;
  comment: string | null;
}

export interface CustomTypeDef {
  id: string;
  name: string;
  fields: CustomFieldDef[];
  is_union: boolean;
  size: number | null;
  comment: string | null;
}

// -------------------------------------------------------------------------
// Address math (hex strings)
// -------------------------------------------------------------------------

export function parseHex(hex: string): bigint {
  return parseAddress(hex) ?? 0n;
}

export function toHex(v: bigint): string {
  return "0x" + v.toString(16).toUpperCase();
}

export function addHex(hex: string, delta: number | bigint): string {
  return toHex(parseHex(hex) + BigInt(delta));
}

// -------------------------------------------------------------------------
// Reading values from a little-endian byte blob
// -------------------------------------------------------------------------

function readUint(bytes: Uint8Array, off: number, size: number): bigint {
  let v = 0n;
  for (let i = 0; i < size; i++) {
    v |= BigInt(bytes[off + i] ?? 0) << BigInt(8 * i);
  }
  return v;
}

function readInt(bytes: Uint8Array, off: number, size: number): bigint {
  let v = readUint(bytes, off, size);
  if (size > 0) {
    const bits = BigInt(8 * size);
    if ((v >> (bits - 1n)) & 1n) v -= 1n << bits;
  }
  return v;
}

function printableChar(code: number): string {
  if (code === 0) return "\\0";
  if (code >= 0x20 && code < 0x7f) return String.fromCharCode(code);
  return "\\x" + code.toString(16).padStart(2, "0");
}

function decodeCharArray(bytes: Uint8Array, off: number, count: number): string {
  let out = "";
  for (let i = 0; i < count; i++) {
    const c = bytes[off + i] ?? 0;
    if (c === 0) break;
    out += printableChar(c);
  }
  return `"${out}"`;
}

function decodeWCharArray(bytes: Uint8Array, off: number, count: number): string {
  let out = "";
  for (let i = 0; i < count; i++) {
    const lo = bytes[off + i * 2] ?? 0;
    const hi = bytes[off + i * 2 + 1] ?? 0;
    const c = lo | (hi << 8);
    if (c === 0) break;
    out += c >= 0x20 && c < 0xffff ? String.fromCharCode(c) : printableChar(c);
  }
  return `L"${out}"`;
}

export interface RenderedValue {
  /** Display text for the member value. */
  text: string;
  /** For pointer members, the pointed-to address (hex), for following. */
  pointer?: string;
  /** Raw numeric value (for enum name lookup), when integral. */
  numeric?: bigint;
}

/** Render a member's value from the struct blob. `bytes` covers the whole struct
 * instance; `off` is the member offset. Returns "??" when the blob doesn't reach. */
export function renderValue(
  ref: TypeRef,
  bytes: Uint8Array | null,
  off: number,
  bitPosition: number | null,
  bitLength: number | null,
): RenderedValue {
  if (!bytes) return { text: "" };
  const size = ref.size;
  if (ref.class.kind !== "array" && ref.class.kind !== "udt" && off + size > bytes.length) {
    return { text: "??" };
  }

  switch (ref.class.kind) {
    case "int": {
      let v = readInt(bytes, off, size);
      if (bitLength != null && bitPosition != null) {
        const raw = readUint(bytes, off, size) >> BigInt(bitPosition);
        v = raw & ((1n << BigInt(bitLength)) - 1n);
      }
      return { text: `${v} (${toHex(v & ((1n << BigInt(Math.max(size, 1) * 8)) - 1n))})`, numeric: v };
    }
    case "uint": {
      let v = readUint(bytes, off, size);
      if (bitLength != null && bitPosition != null) {
        v = (v >> BigInt(bitPosition)) & ((1n << BigInt(bitLength)) - 1n);
      }
      return { text: `${v} (${toHex(v)})`, numeric: v };
    }
    case "bool": {
      const v = readUint(bytes, off, size);
      return { text: v === 0n ? "false" : "true", numeric: v };
    }
    case "char": {
      const c = bytes[off] ?? 0;
      return { text: `'${printableChar(c)}' (${c})`, numeric: BigInt(c) };
    }
    case "wchar": {
      const c = (bytes[off] ?? 0) | ((bytes[off + 1] ?? 0) << 8);
      return { text: `L'${printableChar(c)}' (${c})`, numeric: BigInt(c) };
    }
    case "float": {
      const dv = new DataView(bytes.buffer, bytes.byteOffset + off, Math.min(size, bytes.length - off));
      const v = size >= 8 ? dv.getFloat64(0, true) : dv.getFloat32(0, true);
      return { text: `${v}` };
    }
    case "pointer": {
      const v = readUint(bytes, off, size || 8);
      return { text: toHex(v), pointer: toHex(v), numeric: v };
    }
    case "array": {
      const el = ref.class.element;
      if (el.class.kind === "char") return { text: decodeCharArray(bytes, off, ref.class.count) };
      if (el.class.kind === "wchar") return { text: decodeWCharArray(bytes, off, ref.class.count) };
      return { text: `${el.name}[${ref.class.count}]` };
    }
    case "enum": {
      const v = readInt(bytes, off, size || 4);
      return { text: toHex(v), numeric: v };
    }
    case "udt":
      return { text: "" };
    case "void":
      return { text: "void" };
    default:
      return { text: toHex(readUint(bytes, off, Math.min(size || 1, 8))) };
  }
}

/** True when a member can be expanded into a nested struct/enum/array view. */
export function isExpandable(ref: TypeRef): boolean {
  const k = ref.class.kind;
  if (k === "udt" || k === "enum") return true;
  if (k === "pointer") {
    const pk = ref.class.pointee.class.kind;
    return pk === "udt" || pk === "enum";
  }
  if (k === "array") {
    const ek = ref.class.element.class.kind;
    return ek === "udt" || ek === "enum";
  }
  return false;
}
