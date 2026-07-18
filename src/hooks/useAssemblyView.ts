import { useState, useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { toastError } from '@/lib/logger';
import {
  parseAddress,
  parseAddressExpression,
  RegisterContext,
  SymbolResolver,
} from '@/lib/hexUtils';
import { formatTauriError, isBenignSessionError } from '@/lib/sessionHelpers';
import { useNavigationChannel } from '@/hooks/useNavigationChannel';
import { disassemblyNavigation } from '@/lib/navigationStore';
import { NavHistoryStore } from '@/lib/navHistory';

// Instruction interface matching backend SerializableInstruction
export interface Instruction {
  address: string;
  // Symbolized label; null when the address resolves to no module/symbol
  // (the view falls back to rendering the address).
  symbol: string | null;
  bytes: string;
  mnemonic: string;
  op_str: string;
  is_jump: boolean;
  is_call: boolean;
  is_ret: boolean;
  jump_target: string | null;
  is_patched?: boolean;
}

// Event payloads from Tauri
interface FunctionDisassemblyResult {
  session_id: string;
  address: number;
  instructions: Instruction[];
  function_start: string | null;
  function_end: string | null;
  function_name: string | null;
}

interface FunctionDisassemblyError {
  session_id: string;
  address: number;
  error: string;
}

// Settings stored in localStorage
interface AssemblyViewSettings {
  showBytes: boolean;
}

const SETTINGS_KEY = 'assembly-view-settings';
// Fallback limit when function bounds aren't available
// The backend will use actual function bounds when possible
const DEFAULT_MAX_INSTRUCTIONS = 2000;

function loadSettings(): AssemblyViewSettings {
  try {
    const stored = localStorage.getItem(SETTINGS_KEY);
    if (stored) {
      return JSON.parse(stored);
    }
  } catch (e) {
    console.error('Failed to load assembly view settings:', e);
  }
  return { showBytes: true };
}

function saveSettings(settings: AssemblyViewSettings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (e) {
    console.error('Failed to save assembly view settings:', e);
  }
}

export interface AssemblyViewState {
  instructions: Instruction[];
  currentAddress: bigint | null;
  pcAddress: bigint | null;
  functionStart: bigint | null;
  functionEnd: bigint | null;
  functionName: string | null;
  isLoading: boolean;
  error: string | null;
  showBytes: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  // Address to highlight temporarily (after navigation)
  jumpTargetAddress: bigint | null;
  /** Bumps only on a full replace (goto / PC-follow / function load), never on a
   *  scroll extension. The view gates its PC-follow/jump auto-scroll on this so
   *  prepend/append don't re-fire it. */
  loadGeneration: number;
  /** Signals a just-completed prepend of `count` rows at the top (a fresh object
   *  per prepend, so an effect keyed on it re-fires even for equal counts). The
   *  view compensates the scroll offset so the viewport stays visually stable. */
  prependSignal: { count: number };
}

/** Navigation options: `auto` marks PC-follow navigation (no history entry, no
 *  jump-target highlight); `record: false` skips the history entry for
 *  navigations whose departure is recorded elsewhere (cross-window jumps);
 *  `departedAddress` records the exact row the user navigated from (jump-target
 *  clicks) instead of the view's anchor address. */
export interface GoToOptions {
  auto?: boolean;
  record?: boolean;
  departedAddress?: bigint;
}

export interface AssemblyViewActions {
  goToAddress: (expression: string, opts?: GoToOptions) => Promise<void>;
  goToAddressDirect: (address: bigint, opts?: GoToOptions) => void;
  /** Follow a jump/call target from a source row (records the departed row;
   *  in-view targets scroll without reloading). */
  followJump: (target: bigint, source: bigint) => void;
  refresh: () => void;
  toggleBytesColumn: () => void;
  scrollToPC: () => void;
  /** Fetch & prepend earlier instructions (scroll-up). No-op in file mode, while a
   *  request is in flight, or once the top of mapped code is reached. */
  loadMoreAbove: () => void;
  /** Fetch & append later instructions (scroll-down). Same guards as loadMoreAbove. */
  loadMoreBelow: () => void;
}

/// A non-session disassembly source (e.g. a PE file opened from disk). When
/// provided, the hook disassembles through this callback instead of the
/// session's `request_function_disassembly` command + events. Addresses are
/// VAs (load base + RVA). PC-following, breakpoints, and patches do not apply.
export type AsmDisassembleFn = (va: number, count: number) => Promise<Instruction[]>;

export interface UseAssemblyViewOptions {
  sessionId: string | undefined;
  isPaused?: boolean;
  /** False when no target can serve requests (session stopped/exited). Blocks
   * new disassembly requests so the view doesn't spin against a dead session.
   * Request-avoidance only — the correctness guarantee is the backend emitting
   * a terminal (success or error) event for every request it does receive.
   * Defaults to true; irrelevant in file mode. */
  canLoad?: boolean;
  pcAddress?: number; // Current PC from debug event
  registers?: RegisterContext;
  resolveSymbol?: SymbolResolver;
  /** Changes when a module's symbols finish loading in the background; triggers
   * a refresh so raw addresses upgrade to symbol names. */
  symbolsRefreshKey?: string;
  /** Non-session disassembly source (PE file). */
  disassemble?: AsmDisassembleFn;
  /** VA to disassemble first when using a file source. */
  initialAddress?: bigint;
  /** Unified back/forward history for this view's dock scope. The hook pushes
   *  departed addresses on user navigation and consumes the store's
   *  disasmRestore channel. */
  navHistory: NavHistoryStore;
}

// Instructions requested per file disassembly (no function bounds available).
const FILE_DISASM_COUNT = 512;

// Instructions fetched per scroll-driven extension (prepend above / append below).
const EXTEND_CHUNK = 64;
// Hard cap on total loaded rows so infinite scrolling can't grow the array unbounded.
const MAX_LOADED_INSTRUCTIONS = 20000;

// Event payload for backward (prepend) disassembly.
interface DisassemblyBackwardResult {
  session_id: string;
  target: number;
  instructions: Instruction[];
}

// Rows from `incoming` strictly outside `prev`'s loaded range on the given edge.
// `prev` is address-sorted, so the strict boundary comparison alone is a complete
// dedup (an address beyond the boundary row cannot already be loaded).
function freshBeyondEdge(prev: Instruction[], incoming: Instruction[], edge: 'above' | 'below'): Instruction[] {
  const boundary = prev.length
    ? parseAddress(edge === 'above' ? prev[0].address : prev[prev.length - 1].address)
    : null;
  if (boundary === null) return incoming;
  return incoming.filter((i) => {
    const addr = parseAddress(i.address);
    return addr !== null && (edge === 'above' ? addr < boundary : addr > boundary);
  });
}

// Instruction addresses are backend-formatted hex strings ("0x7ff..."); compare
// against a bigint via the normalized uppercase form.
function isAddressInView(instructions: Instruction[], addr: bigint): boolean {
  const key = `0X${addr.toString(16).toUpperCase()}`;
  return instructions.some((inst) => inst.address.toUpperCase() === key);
}

export function useAssemblyView(options: UseAssemblyViewOptions): AssemblyViewState & AssemblyViewActions {
  const { sessionId, isPaused, canLoad = true, pcAddress: pcAddressProp, registers = {}, resolveSymbol, symbolsRefreshKey, disassemble, initialAddress, navHistory } = options;

  // State
  const [instructions, setInstructions] = useState<Instruction[]>([]);
  const [currentAddress, setCurrentAddress] = useState<bigint | null>(null);
  const [functionStart, setFunctionStart] = useState<bigint | null>(null);
  const [functionEnd, setFunctionEnd] = useState<bigint | null>(null);
  const [functionName, setFunctionName] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showBytes, setShowBytes] = useState(() => loadSettings().showBytes);
  // Address to highlight temporarily after navigation (for jump targets)
  const [jumpTargetAddress, setJumpTargetAddress] = useState<bigint | null>(null);

  // Infinite-scroll extension. `loadGeneration` bumps ONLY on a full replace
  // (goto / PC-follow / function load), never on prepend/append — the component
  // gates its PC-follow/jump auto-scroll on it so extensions don't yank the view.
  // `prependSignal` tells the component how many rows were just prepended so it can
  // compensate the scroll offset (keep the viewport visually stable).
  const [loadGeneration, setLoadGeneration] = useState(0);
  const [prependSignal, setPrependSignal] = useState<{ count: number }>({ count: 0 });

  // Refs
  const lastRequestedAddress = useRef<bigint | null>(null);
  const requestInFlight = useRef(false);
  const scrollToPCRef = useRef<(() => void) | null>(null);
  // Mirror of `instructions` for use inside event listeners (avoids stale closures
  // and keeps the setInstructions updater pure).
  const instructionsRef = useRef<Instruction[]>([]);
  // Single-in-flight guards + latched end-of-range flags for scroll extension.
  const loadAboveInFlight = useRef(false);
  const loadBelowInFlight = useRef(false);
  const reachedTop = useRef(false);
  const reachedBottom = useRef(false);
  // Address echoed by a pending forward append request (disambiguates the shared
  // `disassembly-updated` event between append and any legacy full-replace use).
  const pendingAppendTarget = useRef<bigint | null>(null);
  // Track the last PC we auto-navigated to, to detect when PC actually changes (stepping)
  const lastAutoPcAddress = useRef<bigint | null>(null);
  // Track if user manually navigated away from PC
  const userNavigatedAway = useRef<boolean>(false);

  // Derived PC address
  const pcAddress = pcAddressProp != null ? BigInt(pcAddressProp) : null;

  // Keep the listener-visible mirror in sync.
  useEffect(() => { instructionsRef.current = instructions; }, [instructions]);

  // Reset scroll-extension bookkeeping. Called on every full replace (new anchor):
  // a fresh anchor can scroll both ways again, and any in-flight extension is stale.
  const resetExtension = useCallback(() => {
    loadAboveInFlight.current = false;
    loadBelowInFlight.current = false;
    reachedTop.current = false;
    reachedBottom.current = false;
    pendingAppendTarget.current = null;
  }, []);

  // Unified history: re-render on store changes, read availability from the store.
  useSyncExternalStore(navHistory.subscribe, navHistory.getSnapshot);
  const canGoBack = navHistory.canGoBack;
  const canGoForward = navHistory.canGoForward;

  // Keep the store's live disassembly address in sync so tab switches away
  // from this view can snapshot the departed location. While following PC
  // (the user hasn't navigated away), the PC row is the user's position —
  // more precise than the view's anchor address.
  useEffect(() => {
    navHistory.currentDisasmAddress =
      !userNavigatedAway.current && pcAddress !== null ? pcAddress : currentAddress;
  }, [navHistory, currentAddress, pcAddress]);

  // Load disassembly for an address
  const loadDisassembly = useCallback(async (address: bigint) => {
    if (!sessionId && !disassemble) return;
    // Session mode with no live target (stopped/exited): nothing can serve the
    // request — don't enter the loading state at all.
    if (!disassemble && !canLoad) return;

    // Skip duplicate request if already loading the same address
    if (lastRequestedAddress.current === address && requestInFlight.current) return;

    lastRequestedAddress.current = address;
    requestInFlight.current = true;
    setIsLoading(true);
    setError(null);
    // New anchor: reset scroll-extension state (a replace supersedes any extension).
    resetExtension();

    // File data-source: disassemble inline (no function bounds).
    if (disassemble) {
      try {
        const insns = await disassemble(Number(address), FILE_DISASM_COUNT);
        setInstructions(insns);
        setLoadGeneration((g) => g + 1);
        setFunctionStart(null);
        setFunctionEnd(null);
        setFunctionName(null);
        setCurrentAddress(address);
        setError(null);
      } catch (err) {
        setError(formatTauriError(err));
      }
      requestInFlight.current = false;
      setIsLoading(false);
      return;
    }

    try {
      await invoke('request_function_disassembly', {
        sessionId,
        address: Number(address),
        maxInstructions: DEFAULT_MAX_INSTRUCTIONS,
      });
      setCurrentAddress(address);
    } catch (err) {
      const errorMessage = formatTauriError(err);
      // Benign = session running or mid-teardown — not a user-facing failure;
      // the view clears itself on session end.
      if (!isBenignSessionError(errorMessage)) {
        console.error('Failed to request function disassembly:', err);
        setError(errorMessage);
        toastError(`Failed to request disassembly: ${errorMessage}`, sessionId);
      }
      requestInFlight.current = false;
      setIsLoading(false);
    }
  }, [sessionId, disassemble, canLoad, resetExtension]);

  // Prepend earlier instructions (scroll-up). Requests backward disassembly of the
  // rows immediately before the current top; the `disassembly-backward-updated`
  // listener dedups and prepends. Single-in-flight + latched top-reached guard.
  const loadMoreAbove = useCallback(() => {
    if (disassemble || !sessionId || !canLoad) return;
    if (loadAboveInFlight.current || reachedTop.current) return;
    const cur = instructionsRef.current;
    if (cur.length === 0 || cur.length >= MAX_LOADED_INSTRUCTIONS) return;
    const topAddr = parseAddress(cur[0].address);
    if (topAddr === null) return;
    if (topAddr === 0n) { reachedTop.current = true; return; }
    loadAboveInFlight.current = true;
    invoke('request_disassembly_backward', {
      sessionId,
      target: Number(topAddr),
      count: EXTEND_CHUNK,
    }).catch(() => { loadAboveInFlight.current = false; });
  }, [disassemble, sessionId, canLoad]);

  // Append later instructions (scroll-down). Forward-disassembles from the current
  // bottom row (no alignment needed); the shared `disassembly-updated` listener
  // appends the rows past the bottom. Single-in-flight + latched bottom-reached guard.
  const loadMoreBelow = useCallback(() => {
    if (disassemble || !sessionId || !canLoad) return;
    if (loadBelowInFlight.current || reachedBottom.current) return;
    const cur = instructionsRef.current;
    if (cur.length === 0 || cur.length >= MAX_LOADED_INSTRUCTIONS) return;
    const bottomStart = parseAddress(cur[cur.length - 1].address);
    if (bottomStart === null) return;
    loadBelowInFlight.current = true;
    pendingAppendTarget.current = bottomStart;
    // Start at the last row so its known-good boundary anchors the forward decode;
    // dedup drops everything up to and including it, keeping only new rows below.
    invoke('request_disassembly', {
      sessionId,
      address: Number(bottomStart),
      count: EXTEND_CHUNK,
    }).catch(() => {
      loadBelowInFlight.current = false;
      pendingAppendTarget.current = null;
    });
  }, [disassemble, sessionId, canLoad]);

  // Go to address with history management
  const goToAddressDirect = useCallback((address: bigint, opts?: GoToOptions) => {
    const isAutoNavigation = opts?.auto ?? false;
    // Mark that user navigated away from PC (unless this is auto-navigation)
    if (!isAutoNavigation) {
      userNavigatedAway.current = true;
      // Set jump target for highlighting and scrolling
      setJumpTargetAddress(address);
    } else {
      // Auto-navigation (following PC) - no jump target highlight
      setJumpTargetAddress(null);
    }

    // Record the departed address. PC auto-follow isn't a navigation the user
    // can "undo", and cross-window jumps (record: false) already record their
    // departure point at the dock level. The store's currentDisasmAddress is
    // row-accurate after in-view jump clicks, so prefer it over the anchor
    // (the sync effect above keeps it fed from the view's position).
    const record = opts?.record ?? !isAutoNavigation;
    const departed = opts?.departedAddress ?? navHistory.currentDisasmAddress;
    if (record && departed !== null && departed !== address) {
      navHistory.push({ tabId: navHistory.disasmTabId, disasmAddress: departed });
    }

    loadDisassembly(address);
  }, [navHistory, loadDisassembly]);

  // Follow a jump/call target from a source row. Records the departed row so
  // "back" retraces every follow — including in-view targets, which only
  // scroll (no reload) but still enter history, with the store's live position
  // becoming the target so later snapshots (tab switches, forward) are
  // row-accurate.
  const followJump = useCallback((target: bigint, source: bigint) => {
    if (isAddressInView(instructions, target)) {
      navHistory.push({ tabId: navHistory.disasmTabId, disasmAddress: source });
      navHistory.currentDisasmAddress = target;
      setJumpTargetAddress(target);
    } else {
      goToAddressDirect(target, { departedAddress: source });
    }
  }, [instructions, navHistory, goToAddressDirect]);

  // Go to address with expression parsing
  const goToAddress = useCallback(async (expression: string, opts?: GoToOptions) => {
    if (!expression.trim()) return;

    const result = await parseAddressExpression(expression, registers, resolveSymbol);
    if (result.address === null) {
      toastError(result.error || 'Invalid address expression', sessionId);
      return;
    }

    goToAddressDirect(result.address, opts);
  }, [registers, resolveSymbol, goToAddressDirect, sessionId]);

  // Refresh current view
  const refresh = useCallback(() => {
    if (currentAddress !== null) {
      loadDisassembly(currentAddress);
    } else if (pcAddress !== null) {
      loadDisassembly(pcAddress);
    }
  }, [currentAddress, pcAddress, loadDisassembly]);

  // Toggle bytes column
  const toggleBytesColumn = useCallback(() => {
    setShowBytes(prev => {
      const newValue = !prev;
      saveSettings({ showBytes: newValue });
      return newValue;
    });
  }, []);

  // Scroll to PC (placeholder - actual implementation in component)
  const scrollToPC = useCallback(() => {
    if (scrollToPCRef.current) {
      scrollToPCRef.current();
    }
  }, []);

  // Re-request the current view when background symbol loading completes so raw
  // addresses upgrade to symbol names. The ref starts at the mount value, so no
  // refresh fires until the key actually changes.
  const prevSymbolsKey = useRef(symbolsRefreshKey);
  useEffect(() => {
    if (symbolsRefreshKey === prevSymbolsKey.current) return;
    prevSymbolsKey.current = symbolsRefreshKey;
    refresh();
  }, [symbolsRefreshKey, refresh]);

  // Listen for disassembly events (session mode only; file mode resolves inline)
  useEffect(() => {
    if (!sessionId || disassemble) return;

    const unlistenSuccess = listen<FunctionDisassemblyResult>(
      'function-disassembly-updated',
      (event) => {
        if (event.payload.session_id === sessionId) {
          setInstructions(event.payload.instructions);
          setLoadGeneration((g) => g + 1);
          resetExtension();
          setFunctionStart(event.payload.function_start ? BigInt(event.payload.function_start) : null);
          setFunctionEnd(event.payload.function_end ? BigInt(event.payload.function_end) : null);
          setFunctionName(event.payload.function_name);
          requestInFlight.current = false;
          setIsLoading(false);
          setError(null);
        }
      }
    );

    // Backward (prepend) disassembly result: dedup and prepend earlier rows, then
    // signal the component to compensate the scroll offset so the viewport stays put.
    const unlistenBackward = listen<DisassemblyBackwardResult>(
      'disassembly-backward-updated',
      (event) => {
        if (event.payload.session_id !== sessionId) return;
        loadAboveInFlight.current = false;
        const prev = instructionsRef.current;
        const fresh = freshBeyondEdge(prev, event.payload.instructions, 'above');
        if (fresh.length === 0) { reachedTop.current = true; return; }
        setPrependSignal({ count: fresh.length });
        setInstructions([...fresh, ...prev]);
      }
    );

    const unlistenBackwardError = listen<{ session_id: string; target: number; error: string }>(
      'disassembly-backward-error',
      (event) => {
        if (event.payload.session_id !== sessionId) return;
        loadAboveInFlight.current = false;
        // Undecodable / unmapped window above — latch so we don't respin every scroll.
        reachedTop.current = true;
      }
    );

    const unlistenError = listen<FunctionDisassemblyError>(
      'function-disassembly-error',
      (event) => {
        if (event.payload.session_id === sessionId) {
          const msg = event.payload.error || '';
          if (!isBenignSessionError(msg)) {
            setError(msg);
            toastError(`Disassembly failed: ${msg}`, sessionId);
          }
          requestInFlight.current = false;
          setIsLoading(false);
        }
      }
    );

    // Forward disassembly result. Doubles as the scroll-down APPEND channel: when a
    // `loadMoreBelow` is pending and this echoes its requested address, dedup+append
    // the new rows below (no function-bounds reset, no loadGeneration bump). Otherwise
    // it's a legacy full replace.
    const unlistenOldSuccess = listen<{session_id: string, address: number, instructions: Instruction[]}>(
      'disassembly-updated',
      (event) => {
        if (event.payload.session_id !== sessionId) return;
        const pending = pendingAppendTarget.current;
        let echoed: bigint | null = null;
        try { echoed = BigInt(event.payload.address); } catch { echoed = null; }
        const isAppend = pending !== null && echoed !== null && echoed === pending;

        if (isAppend) {
          loadBelowInFlight.current = false;
          pendingAppendTarget.current = null;
          const prev = instructionsRef.current;
          const fresh = freshBeyondEdge(prev, event.payload.instructions, 'below');
          if (fresh.length === 0) { reachedBottom.current = true; return; }
          setInstructions([...prev, ...fresh]);
          return;
        }

        setInstructions(event.payload.instructions);
        setLoadGeneration((g) => g + 1);
        resetExtension();
        setFunctionStart(null);
        setFunctionEnd(null);
        setFunctionName(null);
        requestInFlight.current = false;
        setIsLoading(false);
        setError(null);
      }
    );

    // Refresh disassembly when patches change so patched instructions are shown
    const unlistenPatches = listen<{session_id: string}>(
      'patches-updated',
      (event) => {
        if (event.payload.session_id === sessionId && lastRequestedAddress.current !== null) {
          // Re-request the current disassembly to pick up is_patched flags and new bytes
          invoke('request_function_disassembly', {
            sessionId,
            address: Number(lastRequestedAddress.current),
            maxInstructions: DEFAULT_MAX_INSTRUCTIONS,
          }).catch(() => {
            // Ignore errors (e.g., session ended between patch and refresh)
          });
        }
      }
    );

    return () => {
      unlistenSuccess.then(unlisten => unlisten());
      unlistenBackward.then(unlisten => unlisten());
      unlistenBackwardError.then(unlisten => unlisten());
      unlistenError.then(unlisten => unlisten());
      unlistenOldSuccess.then(unlisten => unlisten());
      unlistenPatches.then(unlisten => unlisten());
    };
  }, [sessionId, disassemble, resetExtension]);

  // External navigation (e.g., symbol click). MUST be declared before the
  // PC-following effect so it runs first on mount and sets userNavigatedAway.
  // record: false — the cross-window jump records the departed location at the
  // dock level (tab switch, or an explicit push when no switch occurs).
  useNavigationChannel(disassemblyNavigation, (addr) => {
    goToAddress(addr, { record: false });
  });

  // History restoration (unified back/forward). A channel, not a callback,
  // because the tab activation that precedes it may remount this view. No
  // history push — restoring is replay, not a new navigation. An address
  // already on screen (in-view follow entries) just scrolls, no reload.
  useNavigationChannel(navHistory.disasmRestore, (addr) => {
    userNavigatedAway.current = true;
    setJumpTargetAddress(addr);
    navHistory.currentDisasmAddress = addr;
    if (!isAddressInView(instructions, addr)) loadDisassembly(addr);
  });

  // Auto-load when PC changes (stepping)
  // When user steps, ALWAYS follow PC regardless of where they were looking
  useEffect(() => {
    if (pcAddress === null || !sessionId || !canLoad) return;

    // Detect if PC actually changed (i.e., user stepped)
    const pcActuallyChanged = lastAutoPcAddress.current === null || pcAddress !== lastAutoPcAddress.current;

    // Initial load - no address set yet
    // Skip if user already navigated (e.g., pending symbol navigation consumed in same render)
    if (currentAddress === null && !userNavigatedAway.current) {
      lastAutoPcAddress.current = pcAddress;
      goToAddressDirect(pcAddress, { auto: true });
      return;
    }

    // If PC actually changed (user stepped), always follow PC
    if (pcActuallyChanged) {
      const isRealStep = lastAutoPcAddress.current !== null;
      const prevPc = lastAutoPcAddress.current;
      lastAutoPcAddress.current = pcAddress;

      // Real step (PC moved to a new address) — always follow PC
      if (isRealStep) {
        // A step is a user action: record the departed location so back
        // retraces the step trail like any other navigation. If the user had
        // navigated away, the departed location is where they were looking
        // (store snapshot); otherwise it's the previous PC row.
        const departed = userNavigatedAway.current
          ? navHistory.currentDisasmAddress ?? prevPc
          : prevPc;
        if (departed !== null && departed !== pcAddress) {
          navHistory.push({ tabId: navHistory.disasmTabId, disasmAddress: departed });
        }

        userNavigatedAway.current = false;
        // Clear any previous jump target so PC scroll effect can work
        setJumpTargetAddress(null);

        // Check if PC is outside current function bounds - need to load new function
        const pcOutsideFunction = functionStart === null || functionEnd === null ||
          pcAddress < functionStart || pcAddress >= functionEnd;

        if (pcOutsideFunction) {
          // PC moved to different function - load it
          goToAddressDirect(pcAddress, { auto: true });
        }
        // If PC is still in current function, scroll effect will handle scrolling to it
      }
      // First time seeing PC (mount) — skip if user already navigated (e.g., symbol click)
    }
    // If PC didn't change, user can freely navigate without being pulled back
  }, [pcAddress, sessionId, canLoad, currentAddress, functionStart, functionEnd, goToAddressDirect, navHistory]);

  // File mode: disassemble the initial offset once on mount.
  useEffect(() => {
    if (!disassemble) return;
    if (currentAddress !== null || instructions.length > 0) return;
    goToAddressDirect(initialAddress ?? 0n, { auto: true });
  }, [disassemble, initialAddress, currentAddress, instructions.length, goToAddressDirect]);

  // Clear state when session ends or stops (session mode only)
  useEffect(() => {
    if (disassemble) return;
    if (!sessionId || isPaused === false) {
      setInstructions([]);
      setCurrentAddress(null);
      setFunctionStart(null);
      setFunctionEnd(null);
      setFunctionName(null);
      setError(null);
      setIsLoading(false);
      lastAutoPcAddress.current = null;
      lastRequestedAddress.current = null;
      requestInFlight.current = false;
      userNavigatedAway.current = false;
      resetExtension();
    }
  }, [sessionId, isPaused, disassemble, resetExtension]);

  return {
    // State
    instructions,
    currentAddress,
    pcAddress,
    functionStart,
    functionEnd,
    functionName,
    isLoading,
    error,
    showBytes,
    canGoBack,
    canGoForward,
    jumpTargetAddress,
    // Infinite-scroll extension
    loadGeneration,
    prependSignal,
    // Actions
    goToAddress,
    goToAddressDirect,
    followJump,
    refresh,
    toggleBytesColumn,
    scrollToPC,
    loadMoreAbove,
    loadMoreBelow,
  };
}
