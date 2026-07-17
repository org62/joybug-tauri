// Navigation store for cross-component navigation in docked tabs.
//
// Problem: when navigating to a docked tab (e.g., "go to disassembly at address X"),
// the target component may remount during tab activation. DOM events and callbacks
// are unreliable across remounts — the old component's listener can consume the
// pending address before the new component mounts.
//
// Solution: a module-level store + useSyncExternalStore. When request() is called,
// React batches the store notification with the tab layout change. The correct
// (possibly remounted) component's effect consumes the pending address.

type Listener = () => void;

export class NavigationChannel<T = string> {
  private _pending: T | null = null;
  private _version = 0;
  private _listeners = new Set<Listener>();

  /** Set a pending navigation target and notify subscribers. */
  request(payload: T) {
    this._pending = payload;
    this._version++;
    this._listeners.forEach(l => l());
  }

  /** Consume the pending navigation target (returns null if already consumed). */
  consume(): T | null {
    const payload = this._pending;
    this._pending = null;
    return payload;
  }

  /** For useSyncExternalStore — subscribe to store changes. */
  subscribe = (onStoreChange: Listener): (() => void) => {
    this._listeners.add(onStoreChange);
    return () => this._listeners.delete(onStoreChange);
  };

  /** For useSyncExternalStore — returns a version that increments on each request. */
  getSnapshot = (): number => this._version;
}

/** Memory/hex navigation with an optional byte range to select at the target. */
export interface MemoryNavRequest {
  address: string;
  selectLength?: number;
}

export const disassemblyNavigation = new NavigationChannel();
export const memoryNavigation = new NavigationChannel<string | MemoryNavRequest>();
// Disassembly row click → source view scrolls/highlights the matching line
// (passive sync; does not steal the active tab).
export const sourceNavigation = new NavigationChannel();
