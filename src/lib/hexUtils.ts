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
 * Format an address as a hex string
 */
export function formatAddress(address: bigint): string {
  return '0x' + address.toString(16).padStart(16, '0').toUpperCase();
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
export function getUnitsPerRow(viewMode: ViewMode): number {
  const config = VIEW_MODE_CONFIGS[viewMode];
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
  return X64_REGISTERS.includes(lower) || ARM64_REGISTERS.includes(lower);
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

/**
 * Parse an address expression with support for:
 * - Hex addresses: 0x7FF8ABCD1234, 7FF8ABCD1234
 * - Decimal addresses: 12345
 * - Registers: rax, rsp, rip, etc.
 * - Symbols: ntdll!NtCreateFile, kernel32!CreateFileW
 * - Simple math: rax+0x10, rsp-8, ntdll!NtCreateFile+0x20
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

  // Tokenize: split on + and - while keeping the operators
  // Handle expressions like: rax+0x10, rsp-8, symbol+offset
  const tokens: { value: string; op: '+' | '-' | null }[] = [];
  let current = '';
  let pendingOp: '+' | '-' | null = null;

  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i];

    if (char === '+' || char === '-') {
      // Check if this is part of a hex number (0x prefix followed by this)
      // or if it's an operator
      if (current.trim()) {
        tokens.push({ value: current.trim(), op: pendingOp });
        current = '';
      }
      pendingOp = char as '+' | '-';
    } else {
      current += char;
    }
  }

  // Push the last token
  if (current.trim()) {
    tokens.push({ value: current.trim(), op: pendingOp });
  }

  if (tokens.length === 0) {
    return { address: null, error: 'Invalid expression' };
  }

  // Evaluate tokens
  let result: bigint = 0n;

  for (const token of tokens) {
    const parsed = parseTerm(token.value, registers);
    let termValue: bigint | null = parsed.value;

    // Need to resolve symbol
    if (parsed.needsSymbolResolution && parsed.symbolName) {
      if (!resolveSymbol) {
        return { address: null, error: `Cannot resolve symbol: ${parsed.symbolName}` };
      }

      try {
        termValue = await resolveSymbol(parsed.symbolName);
        if (termValue === null) {
          return { address: null, error: `Symbol not found: ${parsed.symbolName}` };
        }
      } catch (e) {
        return { address: null, error: `Failed to resolve symbol: ${parsed.symbolName}` };
      }
    }

    if (termValue === null) {
      return { address: null, error: `Invalid term: ${token.value}` };
    }

    // Apply operator
    if (token.op === null || token.op === '+') {
      result += termValue;
    } else if (token.op === '-') {
      result -= termValue;
    }
  }

  // Ensure non-negative
  if (result < 0n) {
    return { address: null, error: 'Result is negative' };
  }

  return { address: result };
}
