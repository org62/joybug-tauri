/**
 * Page protection values. The backend speaks Win32's `PAGE_*` vocabulary on
 * every OS (a Linux mapping's r/w/x is reported as the matching constant), so
 * these are the values `set_memory_protection` takes on both.
 */

interface ProtectOption {
  value: number;
  name: string;
  /** What the pages allow, for the picker ("read, write"). */
  access: string;
  /** False where the OS has no such protection (copy-on-write off Windows). */
  linux: boolean;
}

const BASE_PROTECTIONS: ProtectOption[] = [
  { value: 0x01, name: "PAGE_NOACCESS", access: "no access", linux: true },
  { value: 0x02, name: "PAGE_READONLY", access: "read", linux: true },
  { value: 0x04, name: "PAGE_READWRITE", access: "read, write", linux: true },
  { value: 0x08, name: "PAGE_WRITECOPY", access: "read, copy on write", linux: false },
  { value: 0x10, name: "PAGE_EXECUTE", access: "execute", linux: true },
  { value: 0x20, name: "PAGE_EXECUTE_READ", access: "read, execute", linux: true },
  { value: 0x40, name: "PAGE_EXECUTE_READWRITE", access: "read, write, execute", linux: true },
  { value: 0x80, name: "PAGE_EXECUTE_WRITECOPY", access: "read, execute, copy on write", linux: false },
];

/** Flags OR-ed onto a base protection. Windows only. */
export const PROTECT_MODIFIERS: { value: number; name: string; hint: string }[] = [
  { value: 0x100, name: "PAGE_GUARD", hint: "One-shot: the first access raises a guard-page exception" },
  { value: 0x200, name: "PAGE_NOCACHE", hint: "Non-cached pages" },
  { value: 0x400, name: "PAGE_WRITECOMBINE", hint: "Write-combined pages" },
];

const BASE_MASK = 0xff;
const MODIFIER_MASK = PROTECT_MODIFIERS.reduce((mask, m) => mask | m.value, 0);

export const PAGE_READWRITE = 0x04;
export const PAGE_SIZE = 0x1000;

/** The protections the target OS can apply. */
export function protectionsFor(os: string): ProtectOption[] {
  return os === "windows" ? BASE_PROTECTIONS : BASE_PROTECTIONS.filter((p) => p.linux);
}

/** Split a raw protection into its base value and modifier flags. A value with
 *  no known base (0 for a reserved region) falls back to read-write. */
export function splitProtect(raw: number): { base: number; modifiers: number } {
  const base = raw & BASE_MASK;
  return {
    base: BASE_PROTECTIONS.some((p) => p.value === base) ? base : PAGE_READWRITE,
    modifiers: raw & MODIFIER_MASK,
  };
}
