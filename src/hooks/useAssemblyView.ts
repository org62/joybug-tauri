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
  /** Prefetch adjacent-code context around the loaded function (real steps).
   *  Gotos/restores stay bare so history identity is exact. */
  prefetchContext?: boolean;
}

export interface AssemblyViewActions {
  goToAddress: (expression: string, opts?: GoToOptions) => Promise<void>;
  goToAddressDirect: (address: bigint, opts?: GoToOptions) => void;
  /** Follow a jump/call target from a source row (records the departed row;
   *  in-view targets scroll without reloading). */
  followJump: (target: bigint, source: bigint) => void;
  refresh: () => void;
  toggleBytesColumn: () => void;
  /** Jump back to the current PC: re-enables PC-follow and reloads the PC's
   *  function (with context) unless the PC row is already loaded. Records the
   *  departed location so "back" undoes the jump. */
  goToPC: () => void;
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
  // Mirror of `instructions` for use inside event listeners (avoids stale closures
  // and keeps the setInstructions updater pure).
  const instructionsRef = useRef<Instruction[]>([]);
  // Latched end-of-range flags for scroll extension.
  const reachedTop = useRef(false);
  const reachedBottom = useRef(false);
  // Addresses echoed by pending extension requests; non-null doubles as the
  // single-in-flight guard. Responses that don't match are stale — orphaned by
  // a full replace (goto / PC-follow / refresh) that reset the extension state
  // while they were in flight — and must be discarded, never applied to the
  // new anchor's rows.
  const pendingAppendTarget = useRef<bigint | null>(null);
  const pendingBackwardTarget = useRef<bigint | null>(null);
  // Context-prefetch plumbing: PC-follow loads (stepping) arm it at request
  // time; the replace listener queues it; an effect fires it once the new rows
  // are in. Explicit goto/back keep their exact anchor view — only automatic
  // PC-follow surrounds the PC with adjacent code.
  const prefetchArmed = useRef(false);
  const prefetchQueued = useRef(false);
  // Whether the current view is a context view (function + adjacent code) or a
  // bare anchor view. Refreshes preserve this shape instead of changing it.
  const contextActive = useRef(false);
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
    reachedTop.current = false;
    reachedBottom.current = false;
    pendingAppendTarget.current = null;
    pendingBackwardTarget.current = null;
  }, []);

  // Apply an edge-extension response: verify it echoes the pending request
  // (a mismatch means the request was orphaned by a full replace — discard,
  // never graft old-region rows onto the new anchor), dedup against the loaded
  // range, latch end-of-range when nothing new remains, then prepend/append.
  const applyEdgeExtension = useCallback((edge: 'above' | 'below', echoed: bigint | null, incoming: Instruction[]) => {
    const pending = edge === 'above' ? pendingBackwardTarget : pendingAppendTarget;
    if (pending.current === null || echoed === null || echoed !== pending.current) return;
    pending.current = null;
    const prev = instructionsRef.current;
    const fresh = freshBeyondEdge(prev, incoming, edge);
    if (fresh.length === 0) {
      (edge === 'above' ? reachedTop : reachedBottom).current = true;
      return;
    }
    const next = edge === 'above' ? [...fresh, ...prev] : [...prev, ...fresh];
    // Sync the mirror NOW, not in the effect: the opposite edge's response
    // often arrives in the same tick (context prefetch fires both), and it
    // must build on these rows or its setInstructions clobbers them.
    instructionsRef.current = next;
    if (edge === 'above') setPrependSignal({ count: fresh.length });
    setInstructions(next);
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

  // Load disassembly for an address. `prefetchContext` (PC-follow loads only)
  // arms an automatic one-chunk extension on both sides once the replace lands.
  const loadDisassembly = useCallback(async (address: bigint, prefetchContext = false) => {
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
    prefetchArmed.current = !disassemble && prefetchContext;

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
    if (pendingBackwardTarget.current !== null || reachedTop.current) return;
    const cur = instructionsRef.current;
    if (cur.length === 0 || cur.length >= MAX_LOADED_INSTRUCTIONS) return;
    const topAddr = parseAddress(cur[0].address);
    if (topAddr === null) return;
    if (topAddr === 0n) { reachedTop.current = true; return; }
    pendingBackwardTarget.current = topAddr;
    invoke('request_disassembly_backward', {
      sessionId,
      target: Number(topAddr),
      count: EXTEND_CHUNK,
    }).catch(() => {
      pendingBackwardTarget.current = null;
    });
  }, [disassemble, sessionId, canLoad]);

  // Append later instructions (scroll-down). Forward-disassembles from the current
  // bottom row (no alignment needed); the shared `disassembly-updated` listener
  // appends the rows past the bottom. Single-in-flight + latched bottom-reached guard.
  const loadMoreBelow = useCallback(() => {
    if (disassemble || !sessionId || !canLoad) return;
    if (pendingAppendTarget.current !== null || reachedBottom.current) return;
    const cur = instructionsRef.current;
    if (cur.length === 0 || cur.length >= MAX_LOADED_INSTRUCTIONS) return;
    const bottomStart = parseAddress(cur[cur.length - 1].address);
    if (bottomStart === null) return;
    pendingAppendTarget.current = bottomStart;
    // Start at the last row so its known-good boundary anchors the forward decode;
    // dedup drops everything up to and including it, keeping only new rows below.
    invoke('request_disassembly', {
      sessionId,
      address: Number(bottomStart),
      count: EXTEND_CHUNK,
    }).catch(() => {
      pendingAppendTarget.current = null;
    });
  }, [disassemble, sessionId, canLoad]);

  // Context prefetch: after a PC-follow replace (stepping), pull in one chunk
  // of adjacent code on each side. A function-only view around the PC is
  // disorienting — nearby code should be visible without a manual scroll.
  // Runs after the instructionsRef sync effect above, so the extensions anchor
  // on the freshly replaced rows; prepends/appends don't bump loadGeneration,
  // so this fires at most once per replace.
  useEffect(() => {
    if (!prefetchQueued.current) return;
    prefetchQueued.current = false;
    loadMoreAbove();
    loadMoreBelow();
  }, [loadGeneration, loadMoreAbove, loadMoreBelow]);

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

    loadDisassembly(address, opts?.prefetchContext ?? false);
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

  // Refresh current view, preserving its shape: a context view (stepping) gets
  // its adjacent code re-prefetched after the replace; a bare anchor view
  // (goto/restore) stays bare, so refreshes never change what's on screen.
  const refresh = useCallback(() => {
    const keepContext = contextActive.current;
    if (currentAddress !== null) {
      loadDisassembly(currentAddress, keepContext);
    } else if (pcAddress !== null) {
      loadDisassembly(pcAddress, keepContext);
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

  // Jump back to the current PC (toolbar button; also the recovery path when
  // the view is stranded elsewhere). Behaves like a user navigation (recorded
  // in history) that hands control back to PC-follow.
  const goToPC = useCallback(() => {
    if (pcAddress === null) return;
    const departed = navHistory.currentDisasmAddress;
    if (departed !== null && departed !== pcAddress) {
      navHistory.push({ tabId: navHistory.disasmTabId, disasmAddress: departed });
    }
    userNavigatedAway.current = false;
    setJumpTargetAddress(null);
    navHistory.currentDisasmAddress = pcAddress;
    // Already loaded — the component re-centers the PC row; otherwise reload
    // the PC's function with adjacent context (same shape as a step landing).
    if (!isAddressInView(instructionsRef.current, pcAddress)) {
      loadDisassembly(pcAddress, true);
    }
  }, [pcAddress, navHistory, loadDisassembly]);

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
          // Replace responses must echo the last requested anchor. A mismatch
          // is a stale response — e.g. the slow OOB fallback serving a request
          // that raced a resume (an auto-continued event's PC) and lands after
          // a newer replace — and must never hijack the current view.
          let echoed: bigint | null = null;
          try { echoed = BigInt(event.payload.address); } catch { echoed = null; }
          if (echoed === null || echoed !== lastRequestedAddress.current) return;
          // Sync the mirror immediately so extension responses landing in the
          // same tick anchor on the new rows (their pending guards discard
          // stale ones, but the mirror must never lag a full replace).
          instructionsRef.current = event.payload.instructions;
          setInstructions(event.payload.instructions);
          setLoadGeneration((g) => g + 1);
          resetExtension();
          // An armed replace produces a context view; anything else is bare.
          contextActive.current = prefetchArmed.current;
          if (prefetchArmed.current) {
            prefetchArmed.current = false;
            prefetchQueued.current = true;
          }
          setFunctionStart(event.payload.function_start ? BigInt(event.payload.function_start) : null);
          setFunctionEnd(event.payload.function_end ? BigInt(event.payload.function_end) : null);
          setFunctionName(event.payload.function_name);
          requestInFlight.current = false;
          setIsLoading(false);
          setError(null);
        }
      }
    );

    // Backward (prepend) disassembly result: `applyEdgeExtension` dedups and
    // prepends the earlier rows, then signals the component (via prependSignal)
    // to compensate the scroll offset so the viewport stays put.
    const unlistenBackward = listen<DisassemblyBackwardResult>(
      'disassembly-backward-updated',
      (event) => {
        if (event.payload.session_id !== sessionId) return;
        applyEdgeExtension('above', BigInt(event.payload.target), event.payload.instructions);
      }
    );

    const unlistenBackwardError = listen<{ session_id: string; target: number; error: string }>(
      'disassembly-backward-error',
      (event) => {
        if (event.payload.session_id !== sessionId) return;
        if (pendingBackwardTarget.current === null || BigInt(event.payload.target) !== pendingBackwardTarget.current) return;
        pendingBackwardTarget.current = null;
        // Undecodable / unmapped window above — latch so we don't respin every scroll.
        reachedTop.current = true;
      }
    );

    const unlistenError = listen<FunctionDisassemblyError>(
      'function-disassembly-error',
      (event) => {
        if (event.payload.session_id === sessionId) {
          // Same echo rule as the success channel: a stale error must not
          // clobber a fresher view's state.
          let echoed: bigint | null = null;
          try { echoed = BigInt(event.payload.address); } catch { echoed = null; }
          if (echoed === null || echoed !== lastRequestedAddress.current) return;
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

    // Forward disassembly result — strictly the scroll-down APPEND channel
    // (`loadMoreBelow` is the only requester of forward `request_disassembly`).
    // A stale payload here — one whose request was orphaned by a full replace —
    // must never be treated as a replace: that would hijack the fresh view with
    // an old-edge chunk, which is exactly the "goto/step lands on the wrong
    // rows" bug. `applyEdgeExtension`'s echo check discards it.
    const unlistenOldSuccess = listen<{session_id: string, address: number, instructions: Instruction[]}>(
      'disassembly-updated',
      (event) => {
        if (event.payload.session_id !== sessionId) return;
        let echoed: bigint | null = null;
        try { echoed = BigInt(event.payload.address); } catch { echoed = null; }
        applyEdgeExtension('below', echoed, event.payload.instructions);
      }
    );

    // Refresh disassembly when patches change so patched instructions are shown
    const unlistenPatches = listen<{session_id: string}>(
      'patches-updated',
      (event) => {
        if (event.payload.session_id === sessionId && lastRequestedAddress.current !== null) {
          // Re-request the current disassembly to pick up is_patched flags and
          // new bytes. Context views get their surrounding code back.
          if (contextActive.current) prefetchArmed.current = true;
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
  }, [sessionId, disassemble, resetExtension, applyEdgeExtension]);

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
          // PC moved to a different function — load it with adjacent-code
          // context so the PC never sits in an isolated function-only view.
          goToAddressDirect(pcAddress, { auto: true, prefetchContext: true });
        } else if (!contextActive.current) {
          // Stepping within the loaded function: no reload needed, but upgrade
          // a bare view to a context view so nearby code appears from the
          // first step onward.
          contextActive.current = true;
          loadMoreAbove();
          loadMoreBelow();
        }
        // If PC is still in current function, scroll effect will handle scrolling to it
      }
      // First time seeing PC (mount) — skip if user already navigated (e.g., symbol click)
    }
    // If PC didn't change, user can freely navigate without being pulled back
  }, [pcAddress, sessionId, canLoad, currentAddress, functionStart, functionEnd, goToAddressDirect, navHistory, loadMoreAbove, loadMoreBelow]);

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
      contextActive.current = false;
      prefetchArmed.current = false;
      prefetchQueued.current = false;
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
    goToPC,
    loadMoreAbove,
    loadMoreBelow,
  };
}
