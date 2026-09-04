/**
 * Hex editor utility functions and view mode configurations
 */

export type ViewMode = 'byte' | 'word' | 'dword' | 'qword' | 'float' | 'pointer';

export interface ViewModeConfig {
  bytesPerUnit: number;
  formatValue: (bytes: Uint8Array, littleEndian: boolean) => string;
  parseValue: (str: string) => Uint8Array | null;
  displayWidth: number; // character width for display
}

/**
 * Sanitize address input by removing backticks and other invalid characters.
 * Useful when pasting addresses from tools that format them like: 7ffe`97b87000
 */
export function sanitizeAddressInput(input: string): string {
  return input.replace(/`/g, '');
}

/**
 * Dereference value types - matches the Rust SerializableDereferenceValue enum
 */
export type DereferenceValue =
  | { type: 'Pointer'; address: string; symbol?: string }
  | { type: 'Value'; value: string }
  | { type: 'String'; value: string }
  | { type: 'Instruction'; value: string; symbol?: string }
  | { type: 'LoopDetected'; address: string };

/**
 * Dereference entry - represents one address in the dereference result
 */
export interface DereferenceEntry {
  address: string;
  offset: number;
  chain: DereferenceValue[];
}

/**
 * Dereference result event payload
 */
export interface DereferenceResultPayload {
  session_id: string;
  base_address: string;
  entries: DereferenceEntry[];
}

/**
 * Get the symbol from the first chain item (if it's a pointer with symbol)
 */
export function getFirstChainSymbol(chain: DereferenceValue[]): string | null {
  if (chain.length === 0) return null;
  const first = chain[0];
  if (first.type === 'Pointer' && first.symbol) {
    return first.symbol;
  }
  return null;
}

/**
 * Format a dereference chain as a string for inline display
 * Skips first item - use getFirstChainSymbol to get symbol for pointer column
 */
export function formatDereferenceChain(chain: DereferenceValue[], maxItems: number = 8): string {
  if (chain.length === 0) return '';

  const items: string[] = [];
  // Start from index 1 - first item symbol shown with pointer value
  for (let i = 1; i < Math.min(chain.length, maxItems + 1); i++) {
    const value = chain[i];
    if (!value) break;

    switch (value.type) {
      case 'Pointer':
        const addr = value.address.replace(/^0x0+/, '0x');
        if (value.symbol) {
          // Show address with symbol in brackets
          items.push(addr + ' (' + value.symbol + ')');
        } else {
          items.push(addr);
        }
        break;
      case 'Value':
        items.push(value.value);
        break;
      case 'String':
        items.push(value.value);
        break;
      case 'Instruction':
        if (value.symbol) {
          items.push('(' + value.symbol + ') <' + value.value + '>');
        } else {
          items.push('<' + value.value + '>');
        }
        break;
      case 'LoopDetected':
        items.push('[loop]');
        break;
    }
  }

  if (items.length === 0) return '';

  let result = items.join(' \u2192 ');
  if (chain.length > maxItems + 1) {
    result += ' \u2192 ...';
  }
  return result;
}

/**
 * View mode configurations - designed for extensibility
 * To add a new view mode, simply add an entry here
 */
export const VIEW_MODE_CONFIGS: Record<ViewMode, ViewModeConfig> = {
  byte: {
    bytesPerUnit: 1,
    formatValue: (bytes: Uint8Array) => {
      return bytes[0].toString(16).padStart(2, '0').toUpperCase();
    },
    parseValue: (str: string) => {
      const cleaned = str.replace(/\s/g, '');
      const value = parseInt(cleaned, 16);
      if (isNaN(value) || value < 0 || value > 255) return null;
      return new Uint8Array([value]);
    },
    displayWidth: 2,
  },
  word: {
    bytesPerUnit: 2,
    formatValue: (bytes: Uint8Array, littleEndian: boolean) => {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const value = view.getUint16(0, littleEndian);
      return value.toString(16).padStart(4, '0').toUpperCase();
    },
    parseValue: (str: string) => {
      const cleaned = str.replace(/\s/g, '');
      const value = parseInt(cleaned, 16);
      if (isNaN(value) || value < 0 || value > 0xFFFF) return null;
      const result = new Uint8Array(2);
      const view = new DataView(result.buffer);
      view.setUint16(0, value, true); // little-endian
      return result;
    },
    displayWidth: 4,
  },
  dword: {
    bytesPerUnit: 4,
    formatValue: (bytes: Uint8Array, littleEndian: boolean) => {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const value = view.getUint32(0, littleEndian);
      return value.toString(16).padStart(8, '0').toUpperCase();
    },
    parseValue: (str: string) => {
      const cleaned = str.replace(/\s/g, '');
      const value = parseInt(cleaned, 16);
      if (isNaN(value) || value < 0 || value > 0xFFFFFFFF) return null;
      const result = new Uint8Array(4);
      const view = new DataView(result.buffer);
      view.setUint32(0, value, true);
      return result;
    },
    displayWidth: 8,
  },
  qword: {
    bytesPerUnit: 8,
    formatValue: (bytes: Uint8Array, littleEndian: boolean) => {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const value = view.getBigUint64(0, littleEndian);
      return value.toString(16).padStart(16, '0').toUpperCase();
    },
    parseValue: (str: string) => {
      const cleaned = str.replace(/\s/g, '');
      try {
        const value = BigInt('0x' + cleaned);
        if (value < 0n || value > 0xFFFFFFFFFFFFFFFFn) return null;
        const result = new Uint8Array(8);
        const view = new DataView(result.buffer);
        view.setBigUint64(0, value, true);
        return result;
      } catch {
        return null;
      }
    },
    displayWidth: 16,
  },
  float: {
    bytesPerUnit: 4,
    formatValue: (bytes: Uint8Array, littleEndian: boolean) => {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const value = view.getFloat32(0, littleEndian);
      return value.toPrecision(7);
    },
    parseValue: (str: string) => {
      const value = parseFloat(str);
      if (isNaN(value)) return null;
      const result = new Uint8Array(4);
      const view = new DataView(result.buffer);
      view.setFloat32(0, value, true);
      return result;
    },
    displayWidth: 14,
  },
  pointer: {
    bytesPerUnit: 8,
    formatValue: (bytes: Uint8Array, littleEndian: boolean) => {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const value = view.getBigUint64(0, littleEndian);
      return '0x' + value.toString(16).padStart(16, '0').toUpperCase();
    },
    parseValue: (str: string) => {
      let cleaned = str.replace(/\s/g, '');
      if (cleaned.startsWith('0x') || cleaned.startsWith('0X')) {
        cleaned = cleaned.slice(2);
      }
      try {
        const value = BigInt('0x' + cleaned);
        if (value < 0n || value > 0xFFFFFFFFFFFFFFFFn) return null;
        const result = new Uint8Array(8);
        const view = new DataView(result.buffer);
        view.setBigUint64(0, value, true);
        return result;
      } catch {
        return null;
      }
    },
    displayWidth: 18,
  },
};

/**
 * Format an address as a hex string. `digits` is the target's address width:
 * 16 for a 64-bit process, 8 for a 32-bit (WOW64) one — pass
 * `pointerSize * 2`. Lookup keys (dereference/annotation maps) keep the
 * 16-digit form regardless; only display goes through the width.
 */
export function formatAddress(address: bigint, digits = 16): string {
  return '0x' + address.toString(16).padStart(digits, '0').toUpperCase();
}

/** Pointer-mode config for a 4-byte address space (WOW64 targets): the
 *  `dword` unit rendered as a `0x`-prefixed address. */
const POINTER32_CONFIG: ViewModeConfig = {
  ...VIEW_MODE_CONFIGS.dword,
  formatValue: (bytes, littleEndian) => '0x' + VIEW_MODE_CONFIGS.dword.formatValue(bytes, littleEndian),
  parseValue: (str) => VIEW_MODE_CONFIGS.dword.parseValue(str.replace(/^\s*0x/i, '')),
  displayWidth: 10,
};

/**
 * The unit config for a view mode at a given pointer width: identical to
 * `VIEW_MODE_CONFIGS[viewMode]` except that `pointer` narrows to 4 bytes for
 * a 32-bit target. Every consumer that sizes units must go through this.
 */
export function viewModeConfig(viewMode: ViewMode, pointerSize = 8): ViewModeConfig {
  return viewMode === 'pointer' && pointerSize === 4 ? POINTER32_CONFIG : VIEW_MODE_CONFIGS[viewMode];
}

/** Integer mode with the same unit size as `pointer` at this pointer width. */
export function pointerIntegerMode(pointerSize = 8): ViewMode {
  return pointerSize === 4 ? 'dword' : 'qword';
}

/**
 * Format a signed distance between two addresses, e.g. `-0x20`, `0x0`, `+0x1F0`.
 *
 * Deliberately unpadded, unlike `formatAddress`: the point of the hex view's
 * offset mode is that `+0x10` reads as visibly nearer than `+0x1F0`, and a
 * fixed width would hide exactly the magnitude being scanned for.
 */
export function formatSignedOffset(delta: bigint): string {
  if (delta === 0n) return '0x0';
  const sign = delta < 0n ? '-' : '+';
  const magnitude = (delta < 0n ? -delta : delta).toString(16).toUpperCase();
  return `${sign}0x${magnitude}`;
}

/**
 * Parse an address string to bigint
 */
export function parseAddress(str: string): bigint | null {
  let cleaned = str.trim().replace(/\s/g, '');
  if (cleaned.startsWith('0x') || cleaned.startsWith('0X')) {
    cleaned = cleaned.slice(2);
  }
  try {
    const value = BigInt('0x' + cleaned);
    if (value < 0n) return null;
    return value;
  } catch {
    return null;
  }
}

/**
 * Parse an address string to a JS number, for values that travel over IPC as
 * numbers. Returns null for unparseable input or values above 2^53.
 */
export function parseAddressToNumber(str: string): number | null {
  const v = parseAddress(str);
  return v !== null && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : null;
}

/**
 * Convert a byte to its ASCII character representation
 * Returns '.' for non-printable characters
 */
export function byteToAscii(byte: number): string {
  if (byte >= 0x20 && byte < 0x7F) {
    return String.fromCharCode(byte);
  }
  return '.';
}

/**
 * Convert a Uint8Array to ASCII string representation
 */
export function bytesToAscii(bytes: Uint8Array): string {
  return Array.from(bytes).map(byteToAscii).join('');
}

/**
 * Default bytes per row in hex view
 */
export const BYTES_PER_ROW = 16;

/**
 * Default chunk size for memory reads (4KB)
 */
export const DEFAULT_CHUNK_SIZE = 4096;

/**
 * Threshold for prefetching adjacent chunks
 */
export const PREFETCH_THRESHOLD = 512;

/**
 * Calculate the number of units per row based on view mode
 */
export function getUnitsPerRow(viewMode: ViewMode, pointerSize = 8): number {
  const config = viewModeConfig(viewMode, pointerSize);
  return Math.floor(BYTES_PER_ROW / config.bytesPerUnit);
}

/**
 * X64 register names (lowercase for matching)
 */
const X64_REGISTERS = [
  'rax', 'rbx', 'rcx', 'rdx', 'rsi', 'rdi', 'rbp', 'rsp', 'rip',
  'r8', 'r9', 'r10', 'r11', 'r12', 'r13', 'r14', 'r15', 'eflags'
];

/**
 * 32-bit x86 register names (WOW64 targets)
 */
const X86_REGISTERS = [
  'eax', 'ebx', 'ecx', 'edx', 'esi', 'edi', 'ebp', 'esp', 'eip', 'eflags'
];

/**
 * ARM64 register names (lowercase for matching)
 */
const ARM64_REGISTERS = [
  'x0', 'x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'x7',
  'x8', 'x9', 'x10', 'x11', 'x12', 'x13', 'x14', 'x15',
  'x16', 'x17', 'x18', 'x19', 'x20', 'x21', 'x22', 'x23',
  'x24', 'x25', 'x26', 'x27', 'x28', 'x29', 'x30',
  'sp', 'pc', 'cpsr'
];

/**
 * Register context type for expression evaluation
 */
export interface RegisterContext {
  [key: string]: string | undefined;
}

/**
 * Symbol resolver function type
 */
export type SymbolResolver = (name: string) => Promise<bigint | null>;

/**
 * Result of parsing an address expression
 */
export interface AddressExpressionResult {
  address: bigint | null;
  error?: string;
}

/**
 * Check if a string is a register name
 */
export function isRegisterName(name: string): boolean {
  const lower = name.toLowerCase();
  return X64_REGISTERS.includes(lower) || ARM64_REGISTERS.includes(lower) || X86_REGISTERS.includes(lower);
}

/**
 * Get register value from context
 */
export function getRegisterValue(name: string, context: RegisterContext): bigint | null {
  const lower = name.toLowerCase();
  const value = context[lower];
  if (!value) return null;
  return parseAddress(value);
}

/**
 * Parse a single term (hex number, register, or symbol placeholder)
 * Returns the value or null if it needs async resolution
 */
function parseTerm(
  term: string,
  registers: RegisterContext
): { value: bigint | null; needsSymbolResolution: boolean; symbolName?: string } {
  const trimmed = term.trim();

  // Empty term
  if (!trimmed) {
    return { value: null, needsSymbolResolution: false };
  }

  // Try as hex/decimal number first
  const numValue = parseAddress(trimmed);
  if (numValue !== null) {
    return { value: numValue, needsSymbolResolution: false };
  }

  // Try as register
  if (isRegisterName(trimmed)) {
    const regValue = getRegisterValue(trimmed, registers);
    if (regValue !== null) {
      return { value: regValue, needsSymbolResolution: false };
    }
    // Register name recognized but no value available
    return { value: null, needsSymbolResolution: false };
  }

  // Assume it's a symbol that needs resolution
  return { value: null, needsSymbolResolution: true, symbolName: trimmed };
}

// ============================================================================
// Selection utilities
// ============================================================================

/**
 * Get normalized selection range (start <= end)
 */
export function getNormalizedSelection(
  start: number | null,
  end: number | null
): { start: number; end: number } | null {
  if (start === null || end === null) return null;
  return {
    start: Math.min(start, end),
    end: Math.max(start, end),
  };
}

/**
 * Get bytes from memory for a selection range
 */
export function getSelectedBytes(
  memoryData: Uint8Array,
  startOffset: number,
  endOffset: number
): Uint8Array {
  const start = Math.min(startOffset, endOffset);
  const end = Math.max(startOffset, endOffset);
  return memoryData.slice(start, end + 1);
}

// ============================================================================
// Clipboard format utilities
// ============================================================================

/**
 * Format bytes as ASCII text (non-printable chars become '.')
 */
export function formatBytesAsText(bytes: Uint8Array): string {
  return Array.from(bytes).map(byteToAscii).join('');
}

/**
 * Format bytes as space-separated hex (e.g., "48 65 6C 6C 6F")
 */
export function formatBytesAsHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0').toUpperCase())
    .join(' ');
}

/**
 * Format bytes as hex units according to view mode
 * - byte: "AB CD EF"
 * - word: "CDAB 1234" (little-endian 16-bit)
 * - dword: "12345678" (little-endian 32-bit)
 * - qword: "0123456789ABCDEF" (little-endian 64-bit)
 * - float: treated as dword (4 bytes hex)
 * - pointer: treated as qword (8 bytes hex)
 */
export function formatBytesAsHexUnits(bytes: Uint8Array, viewMode: ViewMode, pointerSize = 8): string {
  // For float/pointer, use the equivalent integer hex format
  let effectiveMode = viewMode;
  if (viewMode === 'float') {
    effectiveMode = 'dword';
  } else if (viewMode === 'pointer') {
    effectiveMode = pointerIntegerMode(pointerSize);
  }

  const config = VIEW_MODE_CONFIGS[effectiveMode];
  const units: string[] = [];

  for (let i = 0; i < bytes.length; i += config.bytesPerUnit) {
    const unitBytes = bytes.slice(i, i + config.bytesPerUnit);
    if (unitBytes.length === config.bytesPerUnit) {
      units.push(config.formatValue(unitBytes, true)); // true = little-endian
    } else {
      // Partial unit at end - format remaining bytes individually
      for (const b of unitBytes) {
        units.push(b.toString(16).padStart(2, '0').toUpperCase());
      }
    }
  }

  return units.join(' ');
}

/**
 * Format bytes as hex dump (full 16-byte rows only)
 * Example: 00007FF812340000: 48 65 6C 6C 6F 20 57 6F 72 6C 64 21 00 00 00 00  Hello World!....
 */
export function formatBytesAsDump(
  memoryData: Uint8Array,
  baseAddress: bigint,
  startOffset: number,
  endOffset: number
): string {
  // Normalize range
  const rangeStart = Math.min(startOffset, endOffset);
  const rangeEnd = Math.max(startOffset, endOffset);

  // Round to row boundaries (full lines only)
  const rowStart = Math.floor(rangeStart / BYTES_PER_ROW) * BYTES_PER_ROW;
  const rowEnd = Math.ceil((rangeEnd + 1) / BYTES_PER_ROW) * BYTES_PER_ROW;

  const lines: string[] = [];

  for (let offset = rowStart; offset < rowEnd && offset < memoryData.length; offset += BYTES_PER_ROW) {
    const rowAddress = baseAddress + BigInt(offset);
    const rowBytes = memoryData.slice(offset, Math.min(offset + BYTES_PER_ROW, memoryData.length));

    // Hex part (space-separated)
    const hexParts: string[] = [];
    for (let i = 0; i < BYTES_PER_ROW; i++) {
      if (i < rowBytes.length) {
        hexParts.push(rowBytes[i].toString(16).padStart(2, '0').toUpperCase());
      } else {
        hexParts.push('  ');
      }
    }
    const hexPart = hexParts.join(' ');

    // ASCII part
    const asciiParts: string[] = [];
    for (let i = 0; i < BYTES_PER_ROW; i++) {
      if (i < rowBytes.length) {
        asciiParts.push(byteToAscii(rowBytes[i]));
      } else {
        asciiParts.push(' ');
      }
    }
    const asciiPart = asciiParts.join('');

    lines.push(`${formatAddress(rowAddress)}: ${hexPart}  ${asciiPart}`);
  }

  return lines.join('\n');
}

/**
 * Parse hex string to bytes
 * Accepts: "48656C6C6F", "48 65 6C 6C 6F", "0x48 0x65", "0x48, 0x65"
 * Returns null if invalid
 */
export function parseHexToBytes(hex: string): Uint8Array | null {
  // Remove 0x prefixes, spaces, commas, and other separators
  const cleaned = hex
    .replace(/0x/gi, '')
    .replace(/[\s,;]/g, '')
    .replace(/[^0-9A-Fa-f]/g, '');

  if (cleaned.length === 0) {
    return null;
  }

  // Pad with leading zero if odd length
  const padded = cleaned.length % 2 === 1 ? '0' + cleaned : cleaned;

  const bytes: number[] = [];
  for (let i = 0; i < padded.length; i += 2) {
    const byte = parseInt(padded.substring(i, i + 2), 16);
    if (isNaN(byte)) return null;
    bytes.push(byte);
  }

  return new Uint8Array(bytes);
}

/**
 * Check if a character is a valid hex digit
 */
export function isHexChar(char: string): boolean {
  return /^[0-9A-Fa-f]$/.test(char);
}

// ============================================================================
// Address expression parsing
// ============================================================================

/** Characters that act as binary/unary operators in address expressions. */
const EXPRESSION_OPERATORS = '+-*/%';

type ExprToken =
  | { kind: 'op'; op: '+' | '-' | '*' | '/' | '%' }
  | { kind: 'lparen' }
  | { kind: 'rparen' }
  | { kind: 'atom'; text: string };

type ExprNode =
  | { kind: 'atom'; text: string }
  | { kind: 'neg'; operand: ExprNode }
  | { kind: 'binary'; op: '+' | '-' | '*' | '/' | '%'; left: ExprNode; right: ExprNode };

/** Thrown while tokenizing/parsing/evaluating; the message reaches the user. */
class ExpressionError extends Error {}

/**
 * Split an expression into atoms, operators and parentheses.
 *
 * An atom runs until the next operator or parenthesis, so interior spaces are
 * kept (`operator new+8`) but `rax * 8` splits into three tokens. A `(` that
 * opens *inside* an atom is treated as part of it, together with everything up
 * to its matching `)` — that keeps demangled signatures such as
 * `mod!foo(void *)+0x10` intact while still allowing grouping like `(rax+8)*2`.
 */
function tokenizeExpression(input: string): ExprToken[] {
  const tokens: ExprToken[] = [];
  let i = 0;

  while (i < input.length) {
    const char = input[i];

    if (/\s/.test(char)) {
      i++;
      continue;
    }
    if (EXPRESSION_OPERATORS.includes(char)) {
      tokens.push({ kind: 'op', op: char as '+' | '-' | '*' | '/' | '%' });
      i++;
      continue;
    }
    if (char === '(') {
      tokens.push({ kind: 'lparen' });
      i++;
      continue;
    }
    if (char === ')') {
      tokens.push({ kind: 'rparen' });
      i++;
      continue;
    }

    const start = i;
    let depth = 0;
    while (i < input.length) {
      const c = input[i];
      if (depth === 0) {
        if (c === ')' || EXPRESSION_OPERATORS.includes(c)) break;
        if (c === '(') depth++;
      } else if (c === '(') {
        depth++;
      } else if (c === ')') {
        depth--;
      }
      i++;
    }

    const text = input.slice(start, i).trim();
    if (text) tokens.push({ kind: 'atom', text });
  }

  return tokens;
}

/**
 * Recursive-descent parse of the token stream.
 * Grammar (lowest to highest precedence):
 *   sum     := product (('+' | '-') product)*
 *   product := unary (('*' | '/' | '%') unary)*
 *   unary   := ('+' | '-') unary | primary
 *   primary := '(' sum ')' | atom
 */
function parseExpressionTokens(tokens: ExprToken[]): ExprNode {
  let pos = 0;
  const peek = (): ExprToken | undefined => tokens[pos];

  function parseSum(): ExprNode {
    let node = parseProduct();
    for (;;) {
      const token = peek();
      if (token?.kind === 'op' && (token.op === '+' || token.op === '-')) {
        pos++;
        node = { kind: 'binary', op: token.op, left: node, right: parseProduct() };
      } else {
        return node;
      }
    }
  }

  function parseProduct(): ExprNode {
    let node = parseUnary();
    for (;;) {
      const token = peek();
      if (token?.kind === 'op' && (token.op === '*' || token.op === '/' || token.op === '%')) {
        pos++;
        node = { kind: 'binary', op: token.op, left: node, right: parseUnary() };
      } else {
        return node;
      }
    }
  }

  function parseUnary(): ExprNode {
    const token = peek();
    if (token?.kind === 'op') {
      if (token.op === '-') {
        pos++;
        return { kind: 'neg', operand: parseUnary() };
      }
      if (token.op === '+') {
        pos++;
        return parseUnary();
      }
      throw new ExpressionError(`Unexpected operator: ${token.op}`);
    }
    return parsePrimary();
  }

  function parsePrimary(): ExprNode {
    const token = peek();
    if (!token) throw new ExpressionError('Unexpected end of expression');
    if (token.kind === 'lparen') {
      pos++;
      const inner = parseSum();
      if (peek()?.kind !== 'rparen') throw new ExpressionError('Missing closing parenthesis');
      pos++;
      return inner;
    }
    if (token.kind === 'rparen') throw new ExpressionError('Unmatched ")"');
    if (token.kind === 'op') throw new ExpressionError(`Unexpected operator: ${token.op}`);
    pos++;
    return { kind: 'atom', text: token.text };
  }

  const node = parseSum();
  const leftover = peek();
  if (leftover) {
    throw new ExpressionError(leftover.kind === 'rparen' ? 'Unmatched ")"' : 'Invalid expression');
  }
  return node;
}

/**
 * Evaluate a parsed expression, resolving registers and symbols along the way.
 */
async function evaluateExpressionNode(
  node: ExprNode,
  registers: RegisterContext,
  resolveSymbol?: SymbolResolver
): Promise<bigint> {
  switch (node.kind) {
    case 'atom': {
      const parsed = parseTerm(node.text, registers);

      if (parsed.needsSymbolResolution && parsed.symbolName) {
        if (!resolveSymbol) {
          throw new ExpressionError(`Cannot resolve symbol: ${parsed.symbolName}`);
        }
        let resolved: bigint | null;
        try {
          resolved = await resolveSymbol(parsed.symbolName);
        } catch {
          throw new ExpressionError(`Failed to resolve symbol: ${parsed.symbolName}`);
        }
        if (resolved === null) {
          throw new ExpressionError(`Symbol not found: ${parsed.symbolName}`);
        }
        return resolved;
      }

      if (parsed.value === null) {
        throw new ExpressionError(`Invalid term: ${node.text}`);
      }
      return parsed.value;
    }
    case 'neg':
      return -(await evaluateExpressionNode(node.operand, registers, resolveSymbol));
    case 'binary': {
      const left = await evaluateExpressionNode(node.left, registers, resolveSymbol);
      const right = await evaluateExpressionNode(node.right, registers, resolveSymbol);
      switch (node.op) {
        case '+':
          return left + right;
        case '-':
          return left - right;
        case '*':
          return left * right;
        case '/':
          if (right === 0n) throw new ExpressionError('Division by zero');
          return left / right;
        case '%':
          if (right === 0n) throw new ExpressionError('Division by zero');
          return left % right;
      }
    }
  }
}

/**
 * Parse an address expression with support for:
 * - Hex addresses: 0x7FF8ABCD1234, 7FF8ABCD1234
 * - Decimal addresses: 12345
 * - Registers: rax, rsp, rip, etc.
 * - Symbols: ntdll!NtCreateFile, kernel32!CreateFileW
 * - Math with the usual precedence: `+ - * / %`, unary minus and parentheses,
 *   e.g. `rbp+rax*8+0x4e18`, `rsp-8`, `(rax+8)*2`, `ntdll!NtCreateFile+0x20`
 *
 * Bare numbers are hex, matching the rest of the debugger's address input, so
 * `rax*10` scales by 0x10.
 *
 * @param expression The address expression to parse
 * @param registers Current register values from thread context
 * @param resolveSymbol Optional async function to resolve symbol names to addresses
 * @returns Promise resolving to the computed address or null with error
 */
export async function parseAddressExpression(
  expression: string,
  registers: RegisterContext,
  resolveSymbol?: SymbolResolver
): Promise<AddressExpressionResult> {
  const trimmed = expression.trim();

  if (!trimmed) {
    return { address: null, error: 'Empty expression' };
  }

  try {
    const tokens = tokenizeExpression(trimmed);
    if (tokens.length === 0) {
      return { address: null, error: 'Invalid expression' };
    }

    const result = await evaluateExpressionNode(
      parseExpressionTokens(tokens),
      registers,
      resolveSymbol
    );

    // Ensure non-negative
    if (result < 0n) {
      return { address: null, error: 'Result is negative' };
    }

    return { address: result };
  } catch (e) {
    if (e instanceof ExpressionError) {
      return { address: null, error: e.message };
    }
    return { address: null, error: 'Invalid address expression' };
  }
}
