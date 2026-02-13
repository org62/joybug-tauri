// Module-level store for pending navigation targets.
// Uses custom DOM events to notify listeners without causing React state changes.

let pendingDisassemblyAddress: string | null = null;
let pendingMemoryAddress: string | null = null;

export const NAVIGATE_DISASSEMBLY_EVENT = 'navigate-disassembly';
export const NAVIGATE_MEMORY_EVENT = 'navigate-memory';

export function requestDisassemblyNavigation(address: string) {
  pendingDisassemblyAddress = address;
  window.dispatchEvent(new CustomEvent(NAVIGATE_DISASSEMBLY_EVENT));
}

export function consumePendingDisassemblyNavigation(): string | null {
  const addr = pendingDisassemblyAddress;
  pendingDisassemblyAddress = null;
  return addr;
}

export function requestMemoryNavigation(address: string) {
  pendingMemoryAddress = address;
  window.dispatchEvent(new CustomEvent(NAVIGATE_MEMORY_EVENT));
}

export function consumePendingMemoryNavigation(): string | null {
  const addr = pendingMemoryAddress;
  pendingMemoryAddress = null;
  return addr;
}
