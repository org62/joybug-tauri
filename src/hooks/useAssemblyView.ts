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
  // Every "module!name" starting exactly at this address (offset 0). Usually 0
  // or 1, but aliases (e.g. NtClose/ZwClose) share an address → one label row
  // each, rendered above the instruction — never in the first column, which
  // always shows the address.
  symbols?: string[];
  bytes: string;
  mnemonic: string;
  op_str: string;
  is_jump: boolean;
  is_call: boolean;
  is_ret: boolean;
  jump_target: string | null;
  is_patched?: boolean;
  // When the live bytes differ from the on-disk image: original image bytes
  // (space-separated hex) and their disassembly, shown on hover over the row.
  original_bytes?: string;
  original_disasm?: string;
  // True for a synthetic `db 0xXX` row where a byte couldn't be decoded.
  is_invalid?: boolean;
}

// Display row model: instructions plus the symbol label rows derived from them.
// Labels attach to a single instruction (all names starting at its address), so a
// slice's row count is intrinsic to the slice — prepends never change existing rows.
export type AsmRow =
  | { kind: 'label'; symbol: string; address: string }
  | { kind: 'insn'; insn: Instruction };

export function buildAsmRows(insns: Instruction[]): AsmRow[] {
  const rows: AsmRow[] = [];
  for (const insn of insns) {
    for (const symbol of insn.symbols ?? []) {
      rows.push({ kind: 'label', symbol, address: insn.address });
    }
    rows.push({ kind: 'insn', insn });
  }
  return rows;
}

/** Display-row count of `buildAsmRows(insns)` without materializing the rows. */
export function countAsmRows(insns: Instruction[]): number {
  return insns.reduce((n, insn) => n + 1 + (insn.symbols?.length ?? 0), 0);
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
  // Compare live code against the on-disk image to flag patches/hooks (purple
  // highlight + original-on-hover). Off skips the per-request image diff entirely.
  compareImage: boolean;
}

const SETTINGS_KEY = 'assembly-view-settings';
// Fallback limit when function bounds aren't available
// The backend will use actual function bounds when possible
const DEFAULT_MAX_INSTRUCTIONS = 2000;

// Image-patch comparison defaults OFF: it adds a per-request cost (build an
// on-disk image snapshot, then for every decoded instruction re-read + compare
// the original bytes, re-disassembling any that differ) over the WHOLE requested
// function — a real hit on large functions during navigation/stepping. It's an
// opt-in "show me hooks/patches" lens the user flips on from the toolbar when
// wanted, not something every disassembly should pay for.
const DEFAULT_SETTINGS: AssemblyViewSettings = { showBytes: true, compareImage: false };

function loadSettings(): AssemblyViewSettings {
  try {
    const stored = localStorage.getItem(SETTINGS_KEY);
    if (stored) {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(stored) };
    }
  } catch (e) {
    console.error('Failed to load assembly view settings:', e);
  }
  return { ...DEFAULT_SETTINGS };
}

// Merge a partial update into the persisted settings (each toggle owns one field).
function persistSettings(partial: Partial<AssemblyViewSettings>) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...loadSettings(), ...partial }));
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
  /** Whether live code is compared against the on-disk image (patch highlight). */
  compareImage: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  // Address to highlight temporarily (after navigation)
  jumpTargetAddress: bigint | null;
  /** Bumps only on a full replace (goto / PC-follow / function load), never on a
   *  scroll extension. The view gates its PC-follow/jump auto-scroll on this so
   *  prepend/append don't re-fire it. */
  loadGeneration: number;
  /** Signals a just-completed prepend of `count` DISPLAY rows at the top —
   *  instructions plus their derived label rows (`buildAsmRows`), matching what
   *  the view actually inserts. A fresh object per prepend, so an effect keyed
   *  on it re-fires even for equal counts. The view compensates the scroll
   *  offset so the viewport stays visually stable. */
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
  /** Toggle live-vs-disk patch comparison; re-requests so highlights appear/clear. */
  toggleImageCompare: () => void;
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
  const [compareImage, setCompareImage] = useState(() => loadSettings().compareImage);
  // Address to highlight temporarily after navigation (for jump targets)
  const [jumpTargetAddress, setJumpTargetAddress] = useState<bigint | null>(null);

  // Infinite-scroll extension. `loadGeneration` bumps ONLY on a full replace
  // (goto / PC-follow / function load), never on prepend/append — the component
  // gates its PC-follow/jump auto-scroll on it so extensions don't yank the view.
  // `prependSignal` tells the component how many display rows (instructions +
  // label rows) were just prepended so it can compensate the scroll offset
  // (keep the viewport visually stable).
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
  // Patch revision the current disassembly already reflects. The backend
  // re-emits `patches-updated` on EVERY pause (same revision); without this,
  // each step would re-request a full function disassembly of already-shown
  // code (a multi-second stall on large functions). The backend bumps the
  // revision only on view-affecting changes (apply/undo/enable, module
  // reapply, image-byte restore), so we re-decode exactly then.
  const lastPatchRevision = useRef<number | null>(null);

  // Derived PC address
  const pcAddress = pcAddressProp != null ? BigInt(pcAddressProp) : null;

  // Mirror compareImage for the disassembly-request calls so they read the
  // current value without carrying it in every callback's dependency list.
  const compareImageRef = useRef(compareImage);
  useEffect(() => { compareImageRef.current = compareImage; }, [compareImage]);

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
    if (edge === 'above') setPrependSignal({ count: countAsmRows(fresh) });
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
        compareImage: compareImageRef.current,
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
      compareImage: compareImageRef.current,
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
      compareImage: compareImageRef.current,
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
  //
  // Anchor on `lastRequestedAddress` (a ref, always the newest full-replace
  // target), NOT the `currentAddress` state. A background refresh — symbols
  // finished loading, patches changed, image-compare toggled — can fire during
  // the async gap of a step's in-flight load, when `currentAddress` still holds
  // the PREVIOUS function. Reloading that stale address would reset
  // `lastRequestedAddress` to the old value, so the in-flight step's response
  // fails its echo check and is dropped — leaving the view stuck on the old
  // function (the PC row never appears). The ref is already the new target, so
  // a refresh re-requests it and the dup-guard collapses the redundant load.
  const refresh = useCallback(() => {
    const keepContext = contextActive.current;
    const target = lastRequestedAddress.current ?? currentAddress ?? pcAddress;
    if (target !== null) {
      loadDisassembly(target, keepContext);
    }
  }, [currentAddress, pcAddress, loadDisassembly]);

  // Toggle bytes column
  const toggleBytesColumn = useCallback(() => {
    setShowBytes(prev => {
      const newValue = !prev;
      persistSettings({ showBytes: newValue });
      return newValue;
    });
  }, []);

  // Toggle live-vs-disk image comparison. The refresh happens in the effect below
  // once compareImageRef reflects the new value, so the re-request uses it.
  const toggleImageCompare = useCallback(() => {
    setCompareImage(prev => {
      const newValue = !prev;
      persistSettings({ compareImage: newValue });
      return newValue;
    });
  }, []);

  // Re-request the current view when the compare toggle flips so patch highlights
  // appear or clear immediately. The compareImageRef sync effect is declared
  // earlier, so it runs first and the re-request reads the new value.
  const prevCompareImage = useRef(compareImage);
  useEffect(() => {
    if (compareImage === prevCompareImage.current) return;
    prevCompareImage.current = compareImage;
    refresh();
  }, [compareImage, refresh]);

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
            // Drop the previous view's rows: this is a full-replace navigation
            // that failed (e.g. unreadable/unmapped target), so keeping the old
            // instructions would show stale code as if it were the requested
            // address. Clearing lets the error surface instead.
            instructionsRef.current = [];
            setInstructions([]);
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

    // Forward (append) error — the scroll-down counterpart of
    // `disassembly-backward-error`. Without this, a failed append never clears
    // `pendingAppendTarget`, so the single-in-flight guard wedges scroll-down
    // permanently. With resilient decode a bad byte no longer errors; a hard
    // error here means genuinely unreadable memory below, so latch the edge.
    const unlistenForwardError = listen<{ session_id: string; address: number; error: string }>(
      'disassembly-error',
      (event) => {
        if (event.payload.session_id !== sessionId) return;
        let echoed: bigint | null = null;
        try { echoed = BigInt(event.payload.address); } catch { echoed = null; }
        if (pendingAppendTarget.current === null || echoed !== pendingAppendTarget.current) return;
        pendingAppendTarget.current = null;
        reachedBottom.current = true;
      }
    );

    // Refresh disassembly when patches change so patched instructions are shown.
    // The backend re-emits this on every pause with the identical list but the
    // same `revision`; it bumps the revision only on view-affecting changes. Gate
    // the (expensive, full-function) re-decode on that — otherwise every single
    // step would re-disassemble the current function even though nothing changed.
    const unlistenPatches = listen<{ session_id: string; revision: number }>(
      'patches-updated',
      (event) => {
        if (event.payload.session_id !== sessionId || lastRequestedAddress.current === null) return;
        if (event.payload.revision === lastPatchRevision.current) return; // unchanged — nothing to re-decode
        lastPatchRevision.current = event.payload.revision;
        // Re-request the current disassembly to pick up is_patched flags and
        // new bytes. Context views get their surrounding code back.
        if (contextActive.current) prefetchArmed.current = true;
        invoke('request_function_disassembly', {
          sessionId,
          address: Number(lastRequestedAddress.current),
          maxInstructions: DEFAULT_MAX_INSTRUCTIONS,
          compareImage: compareImageRef.current,
        }).catch(() => {
          // Ignore errors (e.g., session ended between patch and refresh)
        });
      }
    );

    return () => {
      unlistenSuccess.then(unlisten => unlisten());
      unlistenBackward.then(unlisten => unlisten());
      unlistenBackwardError.then(unlisten => unlisten());
      unlistenError.then(unlisten => unlisten());
      unlistenOldSuccess.then(unlisten => unlisten());
      unlistenForwardError.then(unlisten => unlisten());
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

        // Reload only when the PC has stepped OUT of the loaded window — not
        // merely out of the current function's bounds. Code without `.pdata`
        // unwind info (stripped/packed/JIT/game binaries — very common) resolves
        // no function bounds, so a bounds-based check treats EVERY step as
        // "left the function" and re-decodes + re-centers the whole view on each
        // step: the stepping flicker. The loaded window already spans a large
        // range around the PC, so an in-window step just moves the highlight and
        // the scroll effect keeps it centered — no re-decode, no flicker.
        const pcLoaded = isAddressInView(instructionsRef.current, pcAddress);

        if (!pcLoaded) {
          // PC left the decoded window — load a fresh view around it, with
          // adjacent-code context so it's never an isolated view.
          goToAddressDirect(pcAddress, { auto: true, prefetchContext: true });
        } else if (!contextActive.current) {
          // In-window step on a bare view (e.g. right after a goto): pull in
          // surrounding code once so nearby instructions are visible.
          contextActive.current = true;
          loadMoreAbove();
          loadMoreBelow();
        }
        // PC already in the window: the scroll effect centers it — no re-decode.
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
      lastPatchRevision.current = null;
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
    compareImage,
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
    toggleImageCompare,
    goToPC,
    loadMoreAbove,
    loadMoreBelow,
  };
}
