// Unified back/forward navigation history.
//
// Problem: back/forward used to be split across two independent stacks — the
// disassembly view's address history and the dock's tab-activation history —
// and which one a "back" press hit depended on where the mouse cursor was.
// After jumping from another window into disassembly, "back" walked old
// disassembly addresses instead of returning to that window, and did nothing
// once the address stack ran dry.
//
// Solution: one chronological stack of *locations*. A location is the dock tab
// the user was on, plus (for the disassembly tab) the address it showed when
// they left. Every user action that moves the view — following a jump, a
// goto, a cross-window "go to disassembly", a tab switch, a debugger step
// moving the PC — pushes the location it departed. Back restores locations
// in reverse user-action order.
//
// The store is UI-framework-agnostic; hosts wire it up:
// - The dock host (SessionDocked / PeReader) registers a controller that can
//   activate a tab without re-recording history, and resolve which tab a
//   restore would displace (for the forward stack).
// - useAssemblyView feeds `currentDisasmAddress`, pushes on address
//   navigations, and consumes `disasmRestore` (a NavigationChannel, because
//   tab activation may remount the view — see navigationStore.ts).
//
// One instance per dock scope: `sessionNavHistory` for the session view, and a
// per-file instance in the PE reader.

import { NavigationChannel } from '@/lib/navigationStore';

export interface NavLocation {
  /** Dock tab id the user was on. */
  tabId: string;
  /** Address the disassembly view showed when this location was left
   *  (only for the disassembly tab). */
  disasmAddress?: bigint;
}

const MAX_HISTORY_SIZE = 50;

function sameLocation(a: NavLocation, b: NavLocation): boolean {
  return a.tabId === b.tabId && a.disasmAddress === b.disasmAddress;
}

export interface NavTabController {
  /** Activate a dock tab without recording the switch into history. */
  restoreTab: (tabId: string) => void;
  /** Active tab of the panel containing `tabId` (null if the tab is gone). */
  activeTabOf: (tabId: string) => string | null;
}

export class NavHistoryStore {
  /** Dock tab id of the disassembly view within this store's scope. */
  readonly disasmTabId: string;

  /** Live address of the disassembly view, fed by useAssemblyView. Used to
   *  snapshot the disassembly location when the user switches away from it. */
  currentDisasmAddress: bigint | null = null;

  /** Address-restore requests consumed by useAssemblyView. */
  readonly disasmRestore = new NavigationChannel<bigint>();

  private backStack: NavLocation[] = [];
  private forwardStack: NavLocation[] = [];
  private controller: NavTabController | null = null;
  private notifyScheduled = false;
  private listeners = new Set<() => void>();
  /** Restore coalescing (see navigate()): the location awaiting restoration. */
  private pendingRestore: NavLocation | null = null;
  private restoreScheduled = false;

  constructor(disasmTabId: string) {
    this.disasmTabId = disasmTabId;
  }

  /** Register the dock host. Returns an unregister function for effect cleanup. */
  setController(controller: NavTabController): () => void {
    this.controller = controller;
    return () => {
      if (this.controller === controller) this.controller = null;
    };
  }

  get canGoBack(): boolean {
    return this.backStack.length > 0;
  }

  get canGoForward(): boolean {
    return this.forwardStack.length > 0;
  }

  /** Record a departed location. Clears the forward stack (a new navigation
   *  forks history, same as a browser). Consecutive duplicates are dropped so
   *  an action observed by two push points can't double-record. */
  push(location: NavLocation) {
    const top = this.backStack[this.backStack.length - 1];
    if (this.forwardStack.length === 0 && top && sameLocation(top, location)) return;
    this.backStack.push(location);
    if (this.backStack.length > MAX_HISTORY_SIZE) this.backStack.shift();
    this.forwardStack = [];
    this.notify();
  }

  /** Record a tab switch: push the departed tab's location (with the
   *  disassembly address snapshot when leaving that tab). */
  recordDeparture(fromTabId: string) {
    this.push(this.snapshotOf(fromTabId));
  }

  /** A jump into disassembly while it's already the active tab produces no
   *  tab switch, so no departure gets recorded — snapshot the departed
   *  address explicitly so "back" can undo the jump. No-op otherwise. */
  recordJumpToDisasm() {
    if (
      this.controller?.activeTabOf(this.disasmTabId) === this.disasmTabId &&
      this.currentDisasmAddress !== null
    ) {
      this.push({ tabId: this.disasmTabId, disasmAddress: this.currentDisasmAddress });
    }
  }

  /** Returns true when a navigation happened (so mouse handlers can block the
   *  native page navigation), false when the stack is empty. */
  goBack(): boolean {
    return this.navigate(this.backStack, this.forwardStack);
  }

  goForward(): boolean {
    return this.navigate(this.forwardStack, this.backStack);
  }

  clear() {
    this.backStack = [];
    this.forwardStack = [];
    this.pendingRestore = null;
    this.notify();
  }

  private navigate(from: NavLocation[], to: NavLocation[]): boolean {
    const target = from.pop();
    if (!target) return false;

    // Capture the location this restore displaces onto the opposite stack.
    const displaced = this.displacedBy(target);
    if (displaced && !sameLocation(displaced, target)) to.push(displaced);

    // Coalesced restore: rapid back/forward presses update the stacks
    // synchronously, but only the final target is restored, one dock layout
    // swap per animation frame. Stacking swaps back-to-back remounts every
    // pane's ScrollArea wrapper mid-commit (its ref callback is a setState),
    // which nests React updates past its depth limit and crashes the page.
    this.pendingRestore = target;
    if (!this.restoreScheduled) {
      this.restoreScheduled = true;
      requestAnimationFrame(() => {
        this.restoreScheduled = false;
        const restore = this.pendingRestore;
        this.pendingRestore = null;
        if (!restore) return;
        // Activate the tab first (may remount the disassembly view), then
        // deliver the address through the channel so the mounted instance
        // consumes it.
        this.controller?.restoreTab(restore.tabId);
        if (restore.disasmAddress !== undefined) this.disasmRestore.request(restore.disasmAddress);
      });
    }
    this.notify();
    return true;
  }

  private displacedBy(target: NavLocation): NavLocation | null {
    // Mid-burst (a restore is still pending), the user's conceptual location
    // is the pending target, not what's on screen.
    if (this.pendingRestore) return this.pendingRestore;
    return this.snapshotOf(this.controller?.activeTabOf(target.tabId) ?? target.tabId);
  }

  /** Location snapshot for a tab: the disassembly tab carries its live address
   *  so a restore can return to the exact row, other tabs are just the id. */
  private snapshotOf(tabId: string): NavLocation {
    return {
      tabId,
      disasmAddress: tabId === this.disasmTabId ? this.currentDisasmAddress ?? undefined : undefined,
    };
  }

  // Deferred: push() can fire from inside React's effect flush for a dock
  // layout commit (the tab-switch diff effect) while rc-dock's class component
  // is mid-reconciliation. Notifying subscribers synchronously there nests
  // React updates past its depth limit ("Maximum update depth exceeded") and
  // crashes the page. A microtask lands after the commit settles (one flush
  // per batch, same scheduled-flag idiom as the restore coalescing above).
  private notify() {
    if (this.notifyScheduled) return;
    this.notifyScheduled = true;
    queueMicrotask(() => {
      this.notifyScheduled = false;
      this.listeners.forEach((l) => l());
    });
  }

  /** For useSyncExternalStore. */
  subscribe = (onStoreChange: () => void): (() => void) => {
    this.listeners.add(onStoreChange);
    return () => this.listeners.delete(onStoreChange);
  };

  /** Snapshot encodes exactly what subscribers read (back/forward
   *  availability), so pushes that don't change availability — e.g. one per
   *  debugger step once back is already enabled — skip the re-render. */
  getSnapshot = (): number =>
    (this.backStack.length ? 1 : 0) | (this.forwardStack.length ? 2 : 0);
}

/** Unified history for the session debugging view. */
export const sessionNavHistory = new NavHistoryStore('disassembly');
