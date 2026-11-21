import { useState, useCallback, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
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
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { disassemblyNavigation } from '@/lib/navigationStore';
import { NavHistoryStore } from '@/lib/navHistory';
import { perfAsmLoadEnd, perfAsmLoadStart, type AsmLoadReason } from "@/lib/perf";
import { hasUsableSymbols, type SymbolStatusKind } from '@/contexts/SessionContext';

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
  // Static data address of a memory operand (RIP-relative or absolute
  // displacement) — the bracketed operand renders as a link to the Memory view.
  mem_ref?: string | null;
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

/** A module's symbol state, as far as a listing cares. */
export interface AsmSymbolStatus {
  base_address: string;
  status: SymbolStatusKind;
}

/** The modules with usable symbols (a PDB or export names), by base address. */
function usableSymbolsByBase(statuses: AsmSymbolStatus[] | undefined): Map<string, SymbolStatusKind> {
  return new Map((statuses ?? []).filter((s) => hasUsableSymbols(s.status)).map((s) => [s.base_address, s.status]));
}

/** A module's address range, for deciding whether its symbols matter to a listing. */
export interface AsmModuleRange {
  base_address: string;
  size: number;
}

/**
 * Whether anything in `insns` can read differently once the module at
 * `[lo, hi)` has symbols: a row inside it (its label, its `module!name`), or a
 * branch target / memory operand pointing into it.
 */
function listingTouchesRange(insns: Instruction[], lo: number, hi: number): boolean {
  if (insns.length === 0) return false;
  const inRange = (hex: string | null | undefined) => {
    if (!hex) return false;
    const n = Number(hex);
    return n >= lo && n < hi;
  };
  // Rows are in address order: the listing's span is its first and last row.
  const first = Number(insns[0].address);
  const last = Number(insns[insns.length - 1].address);
  if (first < hi && last >= lo) return true;
  return insns.some((i) => inRange(i.jump_target) || inRange(i.mem_ref));
}

/** The fields a symbol load or a diagnostic switch can change on a row. */
function sameAnnotations(a: Instruction, b: Instruction): boolean {
  return a.op_str === b.op_str
    && a.jump_target === b.jump_target
    && (a.mem_ref ?? null) === (b.mem_ref ?? null)
    && (a.symbols ?? []).join('\n') === (b.symbols ?? []).join('\n');
}

/** Display-row count of `buildAsmRows(insns)` without materializing the rows. */
export function countAsmRows(insns: Instruction[]): number {
  return insns.reduce((n, insn) => n + 1 + (insn.symbols?.length ?? 0), 0);
}

// Event payloads from Tauri
interface FunctionDisassemblyResult {
  session_id: string;
  address: number;
  request_id: number;
  instructions: Instruction[];
  function_start: string | null;
  function_end: string | null;
  function_name: string | null;
}

interface FunctionDisassemblyError {
  session_id: string;
  address: number;
  request_id: number;
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
// Session events can outlive a mounted view. IDs never restart on remount.
let nextDecodeRequest = 0;

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
  /** Where the last user navigation landed (goto, external jump, in-view jump
   *  follow, history restore) — the view scrolls to and selects this row. Null
   *  while PC-follow owns the view. A fresh object is allocated on every
   *  navigation (even to the same address), so its identity change re-fires the
   *  view's scroll/selection effect. */
  jumpTarget: { address: bigint } | null;
  /** Bumps only on a full replace (goto / PC-follow / function load), never on a
   *  scroll extension. The view gates its PC-follow/jump auto-scroll on this so
   *  prepend/append don't re-fire it. */
  loadGeneration: number;
  /** Changes synchronously when a new viewport-centering intent starts. */
  listingRequest: { readonly current: number };
  /** Signals a just-completed prepend of `count` DISPLAY rows at the top —
   *  instructions plus their derived label rows (`buildAsmRows`), matching what
   *  the view actually inserts. A fresh object per prepend, so an effect keyed
   *  on it re-fires even for equal counts. The view compensates the scroll
   *  offset so the viewport stays visually stable. */
  prependSignal: { count: number };
  /** Forward context can make a previously clamped anchor centerable. */
  appendSeq: number;
  /** Bumps when the rows were updated in place (same instructions, fresher
   *  names). Label rows may have appeared or gone above the viewport: the view
   *  keeps the row at the top of the viewport where it was. */
  annotationSeq: number;
  /** Bumps on every PC-follow decision (step or new pause event, including a
   *  re-hit of the same breakpoint address). The view keys its PC auto-scroll
   *  on this so an unchanged-PC pause still re-centers the RIP row. */
  followSeq: number;
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
  /** Toggle live-vs-disk patch comparison; re-requests so highlights appear/clear. */
  toggleImageCompare: () => void;
  /** Jump back to the current PC: re-enables PC-follow and reloads the PC's
   *  function (with context) unless the PC row is already loaded. Records the
   *  departed location so "back" undoes the jump. */
  goToPC: () => void;
  /** Fetch & prepend earlier instructions unless pending or at the range limit. */
  loadMoreAbove: () => void;
  /** Fetch & append later instructions (scroll-down). Same guards as loadMoreAbove. */
  loadMoreBelow: () => void;
}

/// A non-session disassembly source (e.g. a PE file opened from disk). When
/// provided, the hook disassembles through this callback instead of the
/// session's `request_function_disassembly` command + events. Addresses are
/// VAs (load base + RVA). PC-following, breakpoints, and patches do not apply.
export type AsmDisassembleFn = (kind: 'anchor' | 'forward' | 'backward', va: bigint, count: number) => Promise<Instruction[]>;

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
  /** Session mode: the per-module symbol states behind `symbolsRefreshKey`,
   * which say whose symbols landed. */
  symbolStatuses?: AsmSymbolStatus[];
  /** The process's modules. With them a symbol load refreshes the listing
   * only when the module that got symbols has something to do with it. */
  modules?: AsmModuleRange[];
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

// Instructions fetched per scroll-driven extension (prepend above / append
// below). AssemblyView extends when it is within one viewport of an edge, so a
// chunk must cover a full viewport or the append lands still inside the
// threshold and immediately fires a second request. At DATA_ROW_HEIGHT (18px)
// this covers ~2300px — enough for a maximized panel on a 4K display.
const EXTEND_CHUNK = 128;
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
  const { sessionId, isPaused, canLoad = true, pcAddress: pcAddressProp, registers = {}, resolveSymbol, symbolsRefreshKey, symbolStatuses, modules, disassemble, initialAddress, navHistory } = options;

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
  // Where the last user navigation landed. A fresh object per call (even to the
  // same address) makes the view's scroll/selection effect re-fire on identity.
  const [jumpTarget, setJumpTarget] = useState<{ address: bigint } | null>(null);
  const setJumpTargetAddress = useCallback((address: bigint | null) => {
    setJumpTarget(address === null ? null : { address });
  }, []);

  // Infinite-scroll extension. `loadGeneration` bumps ONLY on a full replace
  // (goto / PC-follow / function load), never on prepend/append — the component
  // gates its PC-follow/jump auto-scroll on it so extensions don't yank the view.
  // `prependSignal` tells the component how many display rows (instructions +
  // label rows) were just prepended so it can compensate the scroll offset
  // (keep the viewport visually stable).
  const [loadGeneration, setLoadGeneration] = useState(0);
  const [prependSignal, setPrependSignal] = useState<{ count: number }>({ count: 0 });
  const [appendSeq, setAppendSeq] = useState(0);
  const [annotationSeq, setAnnotationSeq] = useState(0);
  const [followSeq, setFollowSeq] = useState(0);

  // Raw pause-transition counter. The debounced `displayStatus` swallows runs
  // shorter than its 250ms window (e.g. a breakpoint in a loop re-hitting the
  // same address), so `isPaused`/`pcAddress` props can stay identical across a
  // real resume→hit cycle. useLiveRefresh watches the raw `session-updated`
  // stream and reports every non-Paused→Paused transition; each one must
  // re-assert PC-follow even when the PC value didn't change. isLive=false:
  // only the pause listener is wanted, not the polling interval.
  const [pauseTick, setPauseTick] = useState(0);
  const lastPauseTick = useRef(0);
  useLiveRefresh(disassemble ? undefined : sessionId, false, (reason) => {
    if (reason === 'pause') setPauseTick((t) => t + 1);
  });

  // Refs
  const lastRequestedAddress = useRef<bigint | null>(null);
  const requestInFlight = useRef(false);
  const listingRequest = useRef(0);
  const decodeRequest = useRef(0);
  const invalidatedBy = useRef<AsmLoadReason | null>(null);
  const pendingAnnotation = useRef<string | null>(null);
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

  // Derived PC address — only truthful while paused (or in file mode, where
  // isPaused is undefined): while running/stopped the last event's address is
  // stale, so every consumer (row highlight, goToPC, refresh/prepend anchors)
  // sees null instead of a dead address.
  const pcAddress = isPaused === false || pcAddressProp == null ? null : BigInt(pcAddressProp);

  // Live mirror of `canLoad` for async continuations: a request issued while a
  // process existed can reject after it exited (the Stopped transition), and
  // that late rejection must not surface as an error on a panel that has
  // already cleared itself.
  const canLoadRef = useRef(canLoad);
  useLayoutEffect(() => { canLoadRef.current = canLoad; }, [canLoad]);

  // Mirror compareImage for the disassembly-request calls so they read the
  // current value without carrying it in every callback's dependency list.
  const compareImageRef = useRef(compareImage);
  useEffect(() => { compareImageRef.current = compareImage; }, [compareImage]);

  // Reset scroll-extension bookkeeping. Called on every full replace (new anchor):
  // a fresh anchor can scroll both ways again, and any in-flight extension is stale.
  const resetExtension = useCallback(() => {
    reachedTop.current = false;
    reachedBottom.current = false;
    pendingAppendTarget.current = null;
    pendingBackwardTarget.current = null;
    pendingAnnotation.current = null;
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
    const room = Math.max(0, MAX_LOADED_INSTRUCTIONS - prev.length);
    const fresh = room === 0 ? [] : freshBeyondEdge(prev, incoming, edge);
    if (fresh.length === 0) {
      (edge === 'above' ? reachedTop : reachedBottom).current = true;
      return;
    }
    // Both edges may have been in flight when the cap was nearly reached.
    if (fresh.length > room) fresh.splice(edge === 'above' ? 0 : room, fresh.length - room);
    const next = edge === 'above' ? [...fresh, ...prev] : [...prev, ...fresh];
    if (edge === 'below') setAppendSeq((n) => n + 1);
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
      !disassemble && !userNavigatedAway.current && pcAddress !== null ? pcAddress : currentAddress;
  }, [navHistory, currentAddress, pcAddress, disassemble]);

  // Why the next function load is requested, for the telemetry (`ui.asm.load.<reason>`).
  // Set by a caller right before it triggers a load; anything unset is a
  // user navigation.
  const loadReason = useRef<AsmLoadReason | null>(null);

  const loadEdge = useCallback((edge: 'above' | 'below') => {
    if (requestInFlight.current || (!disassemble && (!sessionId || !canLoadRef.current))) return;
    const above = edge === 'above';
    const pending = above ? pendingBackwardTarget : pendingAppendTarget;
    const reached = above ? reachedTop : reachedBottom;
    if (pending.current !== null || reached.current) return;
    const cur = instructionsRef.current;
    if (cur.length === 0 || cur.length >= MAX_LOADED_INSTRUCTIONS) return;
    // Start at the first/last known instruction boundary. Forward includes
    // the last row, which applyEdgeExtension drops; backward excludes the first.
    const target = parseAddress((above ? cur[0] : cur[cur.length - 1]).address);
    if (target === null) return;
    if (above && target === 0n) { reached.current = true; return; }
    pending.current = target;
    const request = decodeRequest.current;
    if (disassemble) {
      void disassemble(above ? 'backward' : 'forward', target, EXTEND_CHUNK).then(
        (rows) => {
          if (request === decodeRequest.current) applyEdgeExtension(edge, target, rows);
        },
        () => {
          if (request === decodeRequest.current) applyEdgeExtension(edge, target, []);
        },
      );
      return;
    }
    const compareImage = compareImageRef.current;
    void (above
      ? invoke('request_disassembly_backward', { sessionId, target: Number(target), count: EXTEND_CHUNK, compareImage })
      : invoke('request_disassembly', { sessionId, address: Number(target), count: EXTEND_CHUNK, compareImage })
    ).catch(() => {
      if (request === decodeRequest.current && pending.current === target) pending.current = null;
    });
  }, [disassemble, sessionId, applyEdgeExtension]);

  const loadMoreAbove = useCallback(() => loadEdge('above'), [loadEdge]);
  const loadMoreBelow = useCallback(() => loadEdge('below'), [loadEdge]);

  const acceptReplacement = useCallback((address: bigint, rows: Instruction[]) => {
    resetExtension();
    instructionsRef.current = rows;
    setInstructions(rows);
    setLoadGeneration((g) => g + 1);
    requestInFlight.current = false;
    invalidatedBy.current = null;
    setIsLoading(false);
    setError(null);

    // The decoded anchor is ready now. Seed each short side once, using the
    // same guards and merge path as scrolling; edge merges do not seed again.
    const key = `0X${address.toString(16).toUpperCase()}`;
    const index = rows.findIndex((row) => row.address.toUpperCase() === key);
    if (index < 0) return;
    if (index < EXTEND_CHUNK) loadMoreAbove();
    if (rows.length - index - 1 < EXTEND_CHUNK) loadMoreBelow();
  }, [resetExtension, loadMoreAbove, loadMoreBelow]);

  const isPendingLiveRequest = useCallback((address: bigint, request: number) =>
    canLoadRef.current && requestInFlight.current && request === decodeRequest.current
      && address === lastRequestedAddress.current, []);

  const loadDisassembly = useCallback(async (address: bigint) => {
    const reason = loadReason.current ?? "navigation";
    loadReason.current = null;
    if (!disassemble && (!sessionId || !canLoadRef.current)) return;
    const samePending = requestInFlight.current && lastRequestedAddress.current === address;
    if (!disassemble && samePending && (reason === "navigation" || reason === "pc_follow")) return;
    // A newer decode of the same pending anchor (e.g. patches changed during
    // Refresh) supersedes the bytes, not a wheel gesture on that viewport.
    if (!samePending) listingRequest.current++;
    lastRequestedAddress.current = address;
    const request = decodeRequest.current = ++nextDecodeRequest;
    requestInFlight.current = true;
    setCurrentAddress(address);
    setIsLoading(true);
    setError(null);
    resetExtension();

    if (disassemble) {
      try {
        const rows = await disassemble('anchor', address, FILE_DISASM_COUNT);
        if (request === decodeRequest.current) acceptReplacement(address, rows);
      } catch (err) {
        if (request !== decodeRequest.current) return;
        instructionsRef.current = [];
        setInstructions([]);
        setError(formatTauriError(err));
        requestInFlight.current = false;
        invalidatedBy.current = null;
        setIsLoading(false);
      }
      return;
    }

    perfAsmLoadStart(reason, sessionId);
    try {
      await invoke('request_function_disassembly', {
        sessionId,
        address: Number(address),
        maxInstructions: DEFAULT_MAX_INSTRUCTIONS,
        compareImage: compareImageRef.current,
        requestId: request,
      });
    } catch (err) {
      if (!isPendingLiveRequest(address, request)) return;
      requestInFlight.current = false;
      setIsLoading(false);
      const errorMessage = formatTauriError(err);
      if (!isBenignSessionError(errorMessage)) {
        console.error('Failed to request function disassembly:', err);
        setError(errorMessage);
        toastError(`Failed to request disassembly: ${errorMessage}`, sessionId);
      }
    }
  }, [sessionId, disassemble, resetExtension, acceptReplacement, isPendingLiveRequest]);

  // In-view moves don't re-decode unless the loaded bytes/options are already
  // invalid. Carry that invalidation to the new anchor before canceling a load.
  const moveWithinListing = useCallback((address: bigint) => {
    if (requestInFlight.current && lastRequestedAddress.current !== address) {
      if (invalidatedBy.current !== null) {
        loadReason.current = invalidatedBy.current;
        loadDisassembly(address);
        return;
      }
      listingRequest.current++;
      decodeRequest.current = 0;
      requestInFlight.current = false;
      setIsLoading(false);
    }
    lastRequestedAddress.current = address;
    setCurrentAddress(address);
  }, [loadDisassembly]);

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
    if (isAddressInView(instructionsRef.current, target)) {
      userNavigatedAway.current = true;
      navHistory.push({ tabId: navHistory.disasmTabId, disasmAddress: source });
      navHistory.currentDisasmAddress = target;
      setJumpTargetAddress(target);
      moveWithinListing(target);
    } else {
      goToAddressDirect(target, { departedAddress: source });
    }
  }, [navHistory, goToAddressDirect, moveWithinListing]);

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

  // Re-decode the rows on screen and update them in place: same instructions,
  // fresher annotations (symbol labels, named operands). This is what a symbol
  // load calls for — not a reload: the view keeps its rows, its extended
  // context and its scroll position, so nothing flickers. The whole loaded
  // range is asked for in one tagged request and matched back by address.
  const annotationRequestSeq = useRef(0);
  const refreshAnnotations = useCallback(() => {
    if (disassemble || !sessionId || !canLoad) return;
    const cur = instructionsRef.current;
    // A load in flight returns fresh annotations anyway.
    if (cur.length === 0 || requestInFlight.current) return;
    const first = parseAddress(cur[0].address);
    if (first === null) return;
    const requestId = `annotations-${++annotationRequestSeq.current}`;
    pendingAnnotation.current = requestId;
    invoke('request_disassembly', {
      sessionId,
      address: Number(first),
      count: cur.length,
      compareImage: compareImageRef.current,
      requestId,
    }).catch(() => {
      if (pendingAnnotation.current === requestId) pendingAnnotation.current = null;
    });
  }, [disassemble, sessionId, canLoad]);

  // Apply an annotation refresh. Returns false when the code itself turned out
  // to differ (bytes changed under the listing): then only a real reload will do.
  const applyAnnotations = useCallback((incoming: Instruction[]): boolean => {
    const byAddress = new Map(incoming.map((i) => [i.address, i]));
    const prev = instructionsRef.current;
    let changed = false;
    for (const old of prev) {
      const fresh = byAddress.get(old.address);
      if (fresh && fresh.bytes !== old.bytes) return false;
    }
    const next = prev.map((old) => {
      const fresh = byAddress.get(old.address);
      // Rows keep their identity unless something on them changed, so the
      // memoized rows that did not change do not re-render.
      if (!fresh || sameAnnotations(old, fresh)) return old;
      changed = true;
      return fresh;
    });
    if (!changed) return true;
    instructionsRef.current = next;
    setInstructions(next);
    setAnnotationSeq((n) => n + 1);
    return true;
  }, []);

  const refresh = useCallback(() => {
    const target = lastRequestedAddress.current;
    if (target === null) return;
    loadReason.current = "refresh";
    loadDisassembly(target);
  }, [loadDisassembly]);

  const invalidateListing = useCallback((reason: AsmLoadReason) => {
    const target = lastRequestedAddress.current;
    if (target === null) return;
    invalidatedBy.current = reason;
    loadReason.current = reason;
    loadDisassembly(target);
  }, [loadDisassembly]);

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
    invalidateListing("refresh");
  }, [compareImage, invalidateListing]);

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
    if (isAddressInView(instructionsRef.current, pcAddress)) {
      moveWithinListing(pcAddress);
    } else {
      loadDisassembly(pcAddress);
    }
  }, [pcAddress, navHistory, loadDisassembly, moveWithinListing]);

  // Re-request the current view when background symbol loading completes so raw
  // addresses upgrade to symbol names. The ref starts at the mount value, so no
  // refresh fires until the key actually changes.
  //
  // Only for a module the listing has something to do with — one that holds
  // rows on screen or is the target of a branch or memory operand in them. A
  // process loads dozens of modules, each landing its symbols on its own; a
  // listing that reloaded for every one of them flickered once per module.
  // And in place (`refreshAnnotations`), not as a reload.
  const prevSymbolsKey = useRef(symbolsRefreshKey);
  // The modules with symbols as of the last key change, to tell which ones
  // the change was about.
  const prevSymbolStatuses = useRef(usableSymbolsByBase(symbolStatuses));
  const symbolStatusesRef = useRef(symbolStatuses);
  symbolStatusesRef.current = symbolStatuses;
  const modulesRef = useRef(modules);
  modulesRef.current = modules;
  useEffect(() => {
    if (symbolsRefreshKey === prevSymbolsKey.current) return;
    prevSymbolsKey.current = symbolsRefreshKey;
    const before = prevSymbolStatuses.current;
    const now = usableSymbolsByBase(symbolStatusesRef.current);
    prevSymbolStatuses.current = now;
    if (disassemble) {
      // File mode: symbols come from one explicitly loaded file; reload.
      invalidateListing("symbols_loaded");
      return;
    }
    // The modules whose symbols just became usable, or upgraded from export
    // names: their state differs from the one at the last change.
    const relevant = [...now].some(([baseAddress, status]) => {
      if (before.get(baseAddress) === status) return false;
      const base = parseAddress(baseAddress);
      const module = base === null ? undefined : modulesRef.current?.find((m) => parseAddress(m.base_address) === base);
      // A module we cannot place: refresh rather than risk stale names.
      if (base === null || !module) return true;
      return listingTouchesRange(instructionsRef.current, Number(base), Number(base) + module.size);
    });
    if (relevant) refreshAnnotations();
  }, [symbolsRefreshKey, disassemble, invalidateListing, refreshAnnotations]);

  // The diagnostic disassembly switches (Settings -> Diagnostics) changed what
  // a listing contains: re-request the current one.
  useEffect(() => {
    if (!sessionId || disassemble) return;
    const unlisten = listen('disasm-options-changed', () => invalidateListing("refresh"));
    return () => { void unlisten.then((fn) => fn()); };
  }, [sessionId, disassemble, invalidateListing]);

  // Listen for disassembly events (session mode only; file mode resolves inline)
  useEffect(() => {
    if (!sessionId || disassemble) return;

    const unlistenSuccess = listen<FunctionDisassemblyResult>(
      'function-disassembly-updated',
      (event) => {
        const { payload } = event;
        if (payload.session_id !== sessionId) return;
        let echoed: bigint;
        try { echoed = BigInt(payload.address); } catch { return; }
        if (!isPendingLiveRequest(echoed, payload.request_id)) return;
        perfAsmLoadEnd(payload.instructions.length);
        setFunctionStart(payload.function_start ? BigInt(payload.function_start) : null);
        setFunctionEnd(payload.function_end ? BigInt(payload.function_end) : null);
        setFunctionName(payload.function_name);
        acceptReplacement(echoed, payload.instructions);
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
        applyEdgeExtension('above', BigInt(event.payload.target), []);
      }
    );

    const unlistenError = listen<FunctionDisassemblyError>(
      'function-disassembly-error',
      (event) => {
        if (event.payload.session_id !== sessionId) return;
        let echoed: bigint;
        try { echoed = BigInt(event.payload.address); } catch { return; }
        if (!isPendingLiveRequest(echoed, event.payload.request_id)) return;
        requestInFlight.current = false;
        invalidatedBy.current = null;
        setIsLoading(false);
        const msg = event.payload.error || '';
        if (!isBenignSessionError(msg)) {
          setError(msg);
          instructionsRef.current = [];
          setInstructions([]);
          toastError(`Disassembly failed: ${msg}`, sessionId);
        }
      }
    );

    // Forward disassembly result — strictly the scroll-down APPEND channel
    // An orphaned forward payload must never replace the listing. Only a
    // matching pending edge can append it, and tagged reads are annotations.
    const unlistenOldSuccess = listen<{session_id: string, address: number, instructions: Instruction[], request_id?: string | null}>(
      'disassembly-updated',
      (event) => {
        if (event.payload.session_id !== sessionId) return;
        // A tagged answer is an annotation refresh of the loaded range — never
        // an append. Only the latest one asked for counts; if the code itself
        // changed under the listing, fall back to a real reload.
        if (event.payload.request_id) {
          if (event.payload.request_id !== pendingAnnotation.current) return;
          pendingAnnotation.current = null;
          if (!applyAnnotations(event.payload.instructions)) invalidateListing("refresh");
          return;
        }
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
    const unlistenForwardError = listen<{ session_id: string; address: number; error: string; request_id?: string | null }>(
      'disassembly-error',
      (event) => {
        if (event.payload.session_id !== sessionId) return;
        // A failed annotation refresh leaves the rows as they are.
        if (event.payload.request_id) {
          if (event.payload.request_id === pendingAnnotation.current) pendingAnnotation.current = null;
          return;
        }
        let echoed: bigint | null = null;
        try { echoed = BigInt(event.payload.address); } catch { echoed = null; }
        applyEdgeExtension('below', echoed, []);
      }
    );

    // Refresh disassembly when patches change so patched instructions are shown.
    // The backend re-emits this on every pause with the identical list but the
    // same `revision`; it bumps the revision only on view-affecting changes. Gate
    // the (expensive, full-function) re-decode on that — otherwise every single
    // step would re-disassemble the current function even though nothing changed.
    const unlistenPatches = listen<{ session_id: string; revision: number; changed?: boolean }>(
      'patches-updated',
      (event) => {
        if (event.payload.session_id !== sessionId || lastRequestedAddress.current === null) return;
        // `changed` is the backend saying so itself. Comparing revisions alone
        // re-decoded on the first event after every load, when there was no
        // earlier revision to compare with.
        const changed = event.payload.changed ?? event.payload.revision !== lastPatchRevision.current;
        lastPatchRevision.current = event.payload.revision;
        if (!changed) return; // the per-pause re-broadcast — nothing to re-decode
        invalidateListing("patches_updated");
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
  }, [sessionId, disassemble, acceptReplacement, applyAnnotations, applyEdgeExtension, invalidateListing, isPendingLiveRequest]);

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
    if (isAddressInView(instructionsRef.current, addr)) moveWithinListing(addr);
    else loadDisassembly(addr);
  });

  // Auto-load when PC changes (stepping) or a new pause event lands (breakpoint
  // hit — including a re-hit of the SAME address, and a hit after the user
  // navigated the view while the target ran). Either way the RIP row must end
  // up loaded and visible.
  useEffect(() => {
    if (pcAddress === null || !sessionId || !canLoad) return;

    // Detect if PC actually changed (i.e., user stepped)
    const pcActuallyChanged = lastAutoPcAddress.current === null || pcAddress !== lastAutoPcAddress.current;
    // Consume the raw pause tick only past the guards above, so a tick arriving
    // while the session briefly can't load isn't swallowed.
    const newPause = pauseTick !== lastPauseTick.current;
    lastPauseTick.current = pauseTick;

    // Initial load - no address set yet
    // Skip if user already navigated (e.g., pending symbol navigation consumed in same render)
    if (currentAddress === null && !userNavigatedAway.current) {
      lastAutoPcAddress.current = pcAddress;
      loadReason.current = "pc_follow";
      goToAddressDirect(pcAddress, { auto: true });
      return;
    }

    if (pcActuallyChanged || newPause) {
      // A changed PC with a previous PC on record is a step/hit while this view
      // was live. A changed PC with NO previous record is the first sighting on
      // mount — follow only if a fresh pause event says so, otherwise a pending
      // user navigation (e.g. a symbol click that mounted this tab) wins.
      const isRealStep = lastAutoPcAddress.current !== null && pcActuallyChanged;
      const prevPc = lastAutoPcAddress.current;
      lastAutoPcAddress.current = pcAddress;

      if (isRealStep || newPause) {
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
        }

        userNavigatedAway.current = false;
        // Clear any previous jump target so PC scroll effect can work
        setJumpTargetAddress(null);
        // Re-fire the view's PC auto-scroll even when nothing below re-decodes
        // (same-address re-hit, PC already in the loaded window).
        setFollowSeq((s) => s + 1);

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
          loadReason.current = "pc_follow";
          goToAddressDirect(pcAddress, { auto: true });
        } else {
          moveWithinListing(pcAddress);
        }
        // PC already in the window: the scroll effect centers it — no re-decode.
      }
      // First time seeing PC (mount) — skip if user already navigated (e.g., symbol click)
    }
    // If PC didn't change and no new pause landed, user can freely navigate
    // without being pulled back
  }, [pcAddress, pauseTick, sessionId, canLoad, currentAddress, goToAddressDirect, navHistory, moveWithinListing]);

  // Invalidate every file promise on unmount/source change, including edge
  // reads that reject after the image is closed and reopened at the same VA.
  useLayoutEffect(() => {
    if (!disassemble) return;
    return () => {
      listingRequest.current++;
      decodeRequest.current = 0;
      lastRequestedAddress.current = null;
      requestInFlight.current = false;
    };
  }, [disassemble]);

  // File mode: disassemble the initial offset once on mount.
  useEffect(() => {
    if (!disassemble) return;
    if (lastRequestedAddress.current !== null) return;
    goToAddressDirect(initialAddress ?? 0n, { auto: true });
  }, [disassemble, initialAddress, goToAddressDirect]);

  // Clear state when the session ends or its process goes away (session mode
  // only). Keyed on `canLoad`, not `isPaused`: a running target is still a
  // process, and the last decoded view stays visible (without a PC row) until
  // the next pause re-follows the PC.
  useEffect(() => {
    if (disassemble) return;
    if (!sessionId || !canLoad) {
      listingRequest.current++;
      decodeRequest.current = 0;
      instructionsRef.current = [];
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
      invalidatedBy.current = null;
      lastPatchRevision.current = null;
      resetExtension();
    }
  }, [sessionId, canLoad, disassemble, resetExtension]);

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
    jumpTarget,
    listingRequest,
    // Infinite-scroll extension
    loadGeneration,
    prependSignal,
    appendSeq,
    annotationSeq,
    followSeq,
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
