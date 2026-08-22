// Unified back/forward navigation history.
//
// Problem: back/forward used to be split across independent layers — the
// disassembly view's address history, the dock's tab-activation history, and
// the router's page history — and which one a "back" press hit depended on
// what was mounted and where the mouse cursor was. After jumping from another
// window into disassembly, "back" walked old disassembly addresses instead of
// returning to that window; after coming from /logs into a session, it walked
// the dock history instead of returning to /logs; and in the PE reader (whose
// dock history started empty) the press was swallowed and did nothing at all.
//
// Solution: one chronological, app-wide stack of *locations*. A location is
// the router path the user was on, plus (for dock-host pages) the dock tab and,
// for the disassembly tab, the address it showed when they left. Every user
// action that moves the view — a route change, a tab switch, following a jump,
// a goto, a cross-window "go to disassembly", a debugger step moving the PC —
// pushes the location it departed. Back restores locations in reverse
// user-action order, crossing page boundaries when the trail does.
//
// The store is UI-framework-agnostic; hosts wire it up:
// - App registers the router controller (navigate to a path) and keeps
//   `currentPath` in sync from the router location, recording departures.
// - A dock host (SessionDocked / PeReader) registers a dock controller that can
//   activate a tab without re-recording history, resolve which tab a restore
//   would displace (for the forward stack), and names its disassembly tab and
//   its *scope* (session id / PE file path). Tab/address parts of a location
//   are only restored into the scope they were recorded in.
// - useAssemblyView feeds `currentDisasmAddress`, pushes on address
//   navigations, and consumes `disasmRestore` (a NavigationChannel, because
//   tab activation may remount the view — see navigationStore.ts).

import { NavigationChannel } from '@/lib/navigationStore';

export interface NavLocation {
  /** Router path (+search) the user was on, e.g. "/logs", "/session/abc". */
  path: string;
  /** Dock tab id the user was on (dock-host pages only). */
  tabId?: string;
  /** Address the disassembly view showed when this location was left
   *  (only for the disassembly tab). */
  disasmAddress?: bigint;
  /** Dock host scope the tab/address belong to (session id, PE file path).
   *  Guards restores: an address from another file/session is meaningless. */
  scope?: string;
}

/** The dock-host part of a location (everything but the path). */
type HostPart = Pick<NavLocation, 'tabId' | 'disasmAddress' | 'scope'>;

const MAX_HISTORY_SIZE = 50;

function sameLocation(a: NavLocation, b: NavLocation): boolean {
  return (
    a.path === b.path &&
    a.tabId === b.tabId &&
    a.disasmAddress === b.disasmAddress &&
    a.scope === b.scope
  );
}

function dedupeConsecutive(stack: NavLocation[]): NavLocation[] {
  return stack.filter((loc, i) => i === 0 || !sameLocation(stack[i - 1], loc));
}

export interface NavDockController {
  /** Dock tab id of the disassembly view within this host. */
  disasmTabId: string;
  /** Identity of what the host shows (session id, PE file path). */
  scope: string | undefined;
  /** Activate a dock tab without recording the switch into history. */
  restoreTab: (tabId: string) => void;
  /** Active tab of the panel containing `tabId` (null if the tab is gone). */
  activeTabOf: (tabId: string) => string | null;
}

export interface NavRouterController {
  /** Navigate the router to a path without recording it (a restore). */
  navigate: (path: string) => void;
}

export class NavHistoryStore {
  /** Live address of the disassembly view, fed by useAssemblyView. Used to
   *  snapshot the disassembly location when the user leaves it. */
  currentDisasmAddress: bigint | null = null;

  /** Address-restore requests consumed by useAssemblyView. */
  readonly disasmRestore = new NavigationChannel<bigint>();

  /** Router path currently shown (kept in sync by App via setRoute). */
  currentPath = '';

  private backStack: NavLocation[] = [];
  private forwardStack: NavLocation[] = [];
  private dock: NavDockController | null = null;
  private router: NavRouterController | null = null;
  private notifyScheduled = false;
  private listeners = new Set<() => void>();
  /** Restore coalescing (see navigate()): the location awaiting restoration. */
  private pendingRestore: NavLocation | null = null;
  private restoreScheduled = false;
  /** A route restore is in flight: the next route change is ours, don't record it. */
  private restoring = false;
  /** Host part of a cross-route restore, applied when the host of that route
   *  registers its controller (it mounts after the navigation). */
  private pendingHostRestore: { path: string; host: HostPart } | null = null;
  /** Host part frozen when the dock host unregisters: the route-departure
   *  record (App's location effect) runs after the host has unmounted. */
  private departedHost: HostPart = {};

  /** Disassembly tab id of the mounted dock host ('' when none is mounted). */
  get disasmTabId(): string {
    return this.dock?.disasmTabId ?? '';
  }

  /** Register the dock host. Returns an unregister function for effect cleanup. */
  setController(controller: NavDockController): () => void {
    this.dock = controller;
    // A re-registration (deps changed, StrictMode replay) is not a departure.
    this.departedHost = {};
    // A cross-route restore: apply its tab/address now that the host exists
    // (only into the scope it was recorded in — setRoute() drops a pending
    // restore whose page never arrived).
    const pending = this.pendingHostRestore;
    if (pending) {
      this.pendingHostRestore = null;
      if (pending.host.scope === controller.scope) this.applyHost(pending.host);
    }
    return () => {
      if (this.dock !== controller) return;
      this.departedHost = this.hostSnapshot();
      this.dock = null;
    };
  }

  /** Register the router. Returns an unregister function for effect cleanup. */
  setRouter(router: NavRouterController): () => void {
    this.router = router;
    return () => {
      if (this.router === router) this.router = null;
    };
  }

  /** Called by App whenever the router location changes. A user-initiated
   *  change records the departed page (with the dock host's last state); a
   *  change we requested (a restore) is not recorded. */
  setRoute(path: string) {
    if (path === this.currentPath) return;
    const prev = this.currentPath;
    const wasRestoring = this.restoring;
    this.restoring = false;
    if (prev && !wasRestoring) {
      this.push({ path: prev, ...this.departedHost });
    }
    this.departedHost = {};
    this.currentPath = path;
    if (this.pendingHostRestore && this.pendingHostRestore.path !== path) {
      this.pendingHostRestore = null;
    }
  }

  get canGoBack(): boolean {
    return this.backStack.length > 0;
  }

  get canGoForward(): boolean {
    return this.forwardStack.length > 0;
  }

  /** Record a departed location. `path` and `scope` default to the current
   *  page / mounted host. Clears the forward stack (a new navigation forks
   *  history, same as a browser). Consecutive duplicates are dropped so an
   *  action observed by two push points can't double-record. */
  push(location: Partial<NavLocation>) {
    const loc: NavLocation = {
      path: location.path ?? this.currentPath,
      tabId: location.tabId,
      disasmAddress: location.disasmAddress,
      scope: location.scope ?? (location.tabId !== undefined ? this.dock?.scope : undefined),
    };
    const top = this.backStack[this.backStack.length - 1];
    if (this.forwardStack.length === 0 && top && sameLocation(top, loc)) return;
    this.backStack.push(loc);
    if (this.backStack.length > MAX_HISTORY_SIZE) this.backStack.shift();
    this.forwardStack = [];
    this.notify();
  }

  /** Record a tab switch: push the departed tab's location (with the
   *  disassembly address snapshot when leaving that tab). */
  recordDeparture(fromTabId: string) {
    this.push({ path: this.currentPath, ...this.snapshotOf(fromTabId) });
  }

  /** A jump into disassembly while it's already the active tab produces no
   *  tab switch, so no departure gets recorded — snapshot the departed
   *  address explicitly so "back" can undo the jump. No-op otherwise. */
  recordJumpToDisasm() {
    const disasmTabId = this.disasmTabId;
    if (
      this.dock?.activeTabOf(disasmTabId) === disasmTabId &&
      this.currentDisasmAddress !== null
    ) {
      this.push({ tabId: disasmTabId, disasmAddress: this.currentDisasmAddress });
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

  /** The host content of `scope` is gone (session ended, another PE file
   *  opened): its tab/address parts would be meaningless, so reduce those
   *  entries to bare page locations. Route history survives. */
  invalidateScope(scope: string | undefined) {
    if (scope === undefined) return;
    const strip = (stack: NavLocation[]) =>
      dedupeConsecutive(stack.map((loc) => (loc.scope === scope ? { path: loc.path } : loc)));
    this.backStack = strip(this.backStack);
    this.forwardStack = strip(this.forwardStack);
    if (this.pendingHostRestore?.host.scope === scope) this.pendingHostRestore = null;
    this.notify();
  }

  clear() {
    this.backStack = [];
    this.forwardStack = [];
    this.pendingRestore = null;
    this.pendingHostRestore = null;
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
        const { path, ...host } = restore;
        if (path !== this.currentPath) {
          // Another page: navigate there; the host part is applied once that
          // page's dock host registers (it mounts after the navigation).
          this.restoring = true;
          this.pendingHostRestore = host.tabId !== undefined ? { path, host } : null;
          this.router?.navigate(path);
        } else {
          this.applyHost(host);
        }
      });
    }
    this.notify();
    return true;
  }

  /** Activate the tab first (may remount the disassembly view), then deliver
   *  the address through the channel so the mounted instance consumes it. */
  private applyHost(host: HostPart) {
    if (host.tabId !== undefined) this.dock?.restoreTab(host.tabId);
    if (host.disasmAddress !== undefined) this.disasmRestore.request(host.disasmAddress);
  }

  private displacedBy(target: NavLocation): NavLocation | null {
    // Mid-burst (a restore is still pending), the user's conceptual location
    // is the pending target, not what's on screen.
    if (this.pendingRestore) return this.pendingRestore;
    if (target.path === this.currentPath && target.tabId !== undefined && this.dock) {
      return {
        path: this.currentPath,
        ...this.snapshotOf(this.dock.activeTabOf(target.tabId) ?? target.tabId),
      };
    }
    return { path: this.currentPath, ...this.hostSnapshot() };
  }

  /** Location snapshot for a tab: the disassembly tab carries its live address
   *  so a restore can return to the exact row, other tabs are just the id. */
  private snapshotOf(tabId: string): HostPart {
    return {
      tabId,
      disasmAddress: tabId === this.disasmTabId ? this.currentDisasmAddress ?? undefined : undefined,
      scope: this.dock?.scope,
    };
  }

  /** Host part of the current page: the disassembly tab + address when it is
   *  the active tab (so a page-level restore lands back on that row); other
   *  tabs are left to the dock's own persisted layout. */
  private hostSnapshot(): HostPart {
    if (!this.dock) return {};
    const disasmTabId = this.dock.disasmTabId;
    if (this.dock.activeTabOf(disasmTabId) === disasmTabId) return this.snapshotOf(disasmTabId);
    return { scope: this.dock.scope };
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

/** The app-wide navigation history (routes, dock tabs, disassembly addresses). */
export const appNavHistory = new NavHistoryStore();
