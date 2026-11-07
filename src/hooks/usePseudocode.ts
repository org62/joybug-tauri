import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatAddress } from "@/lib/hexUtils";
import { formatTauriError, isBenignSessionError } from "@/lib/sessionHelpers";
import { NavigationChannel } from "@/lib/navigationStore";
import { useNavigationChannel } from "@/hooks/useNavigationChannel";
import { perfRecord, perfWatchWait } from "@/lib/perf";

/** What the backend's `decompile_function` / `pe_decompile` answer. */
export type DecompileOutcome =
  | {
      status: "ok";
      name: string;
      start: string;
      end: string;
      code: string;
      lines: { line: number; addresses: string[] }[];
      differs_from_image: boolean;
    }
  | { status: "no_function" }
  | { status: "superseded" }
  | { status: "failed"; message: string };

/** Decompile the function containing `address` (hex). */
export type DecompileFn = (address: string, client: { id: string; sequence: number }) => Promise<DecompileOutcome>;

/** A decompiled function, indexed for the view. */
interface PseudocodeFunction {
  name: string;
  start: bigint;
  /** Exclusive. */
  end: bigint;
  /** The text as the engine gave it; `lines` is this, split. */
  code: string;
  lines: string[];
  /** 1-based line → the hex addresses of its instructions. */
  lineAddresses: Map<number, string[]>;
  /** Every mapped instruction with its (first) line, ascending by address. */
  addressLines: { address: bigint; line: number }[];
  differsFromImage: boolean;
}

/** Why there is no function on screen. */
type PseudocodeStatus = "idle" | "no_function" | "failed";

/** Where the view should scroll: a new `seq` re-centers the same line. */
interface PseudocodeScrollTarget {
  line: number;
  seq: number;
  /** The line is a navigation target (it is tinted, and flashes once). */
  nav: boolean;
}

interface UsePseudocodeOptions {
  /** Null while there is nothing to decompile from (no file, no session). */
  decompile: DecompileFn | null;
  /** False when the host has no process to ask (a stopped session). */
  canLoad: boolean;
  /** The instruction pointer while paused; the view follows it. */
  pcAddress?: bigint | null;
  /** Shown first when nothing else asks for an address (the file's entry point). */
  initialAddress?: bigint | null;
  /** Identity of what the function at an address is decompiled from and
   *  compared with (its module's symbols, the patches applied): the requested
   *  function is decompiled again when it changes, even during its first load. */
  inputsKeyFor?: (address: bigint) => string;
  /** Addresses other views ask this one to show (a disassembly row click). */
  navigation: NavigationChannel<{ scope: string; address: string }>;
  pseudocodeScope: string;
}

/**
 * What a load does to the view once the function is in: reveal the line of
 * the address as a navigation target, reveal it plainly, or leave the scroll
 * position and highlights alone (the same function, decompiled again).
 */
type Reveal = "nav" | "plain" | "keep";

interface RequestedFunction {
  address: bigint;
  how: Reveal;
  inputsKey: string;
  pending: boolean;
}

/** What is on screen: a function, or why there is none. */
interface PseudocodeResult {
  fn: PseudocodeFunction | null;
  status: PseudocodeStatus;
  error: string | null;
}

const NOTHING: PseudocodeResult = { fn: null, status: "idle", error: null };

/** An outcome as the `outcome` attribute of `ui.pseudocode.load` (the backend's codes). */
const OUTCOME_CODE: Record<DecompileOutcome["status"], number> = { ok: 0, no_function: 1, superseded: 2, failed: 3 };

function indexFunction(outcome: Extract<DecompileOutcome, { status: "ok" }>): PseudocodeFunction {
  const lineAddresses = new Map<number, string[]>();
  const addressLines: { address: bigint; line: number }[] = [];
  for (const { line, addresses } of outcome.lines) {
    lineAddresses.set(line, addresses);
    for (const address of addresses) addressLines.push({ address: BigInt(address), line });
  }
  addressLines.sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : a.line - b.line));
  return {
    name: outcome.name,
    start: BigInt(outcome.start),
    end: BigInt(outcome.end),
    code: outcome.code,
    // The engine ends the text with a newline; that is not a line of code.
    lines: outcome.code.replace(/\n+$/, "").split("\n"),
    lineAddresses,
    // An instruction several lines came from belongs to the first of them.
    addressLines: addressLines.filter((entry, i) => i === 0 || addressLines[i - 1].address !== entry.address),
    differsFromImage: outcome.differs_from_image,
  };
}

const contains = (fn: PseudocodeFunction, address: bigint) => address >= fn.start && address < fn.end;

/**
 * The line an instruction belongs to: its own when it is mapped, otherwise
 * that of the nearest mapped instruction before it. The code ahead of the
 * first mapped instruction (the prologue) belongs to the signature, line 1.
 */
function lineForAddress(fn: PseudocodeFunction, address: bigint): number {
  const entries = fn.addressLines;
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (entries[mid].address <= address) low = mid + 1;
    else high = mid;
  }
  return low === 0 ? 1 : entries[low - 1].line;
}

/**
 * State of a pseudocode view: which function is decompiled, and which of its
 * lines the instruction pointer and the last navigation are on.
 *
 * An address inside the function on screen only moves a highlight; one outside
 * it decompiles the function it is in.
 */
export function usePseudocode({ decompile, canLoad, pcAddress, initialAddress, inputsKeyFor, navigation, pseudocodeScope }: UsePseudocodeOptions) {
  const [{ fn, status, error }, setResult] = useState(NOTHING);
  // Loading another function than the one on screen / the same one again.
  const [busy, setBusy] = useState<"load" | "refresh" | null>(null);
  const [scrollTarget, setScrollTarget] = useState<PseudocodeScrollTarget | null>(null);
  const [followPc, setFollowPc] = useState(true);

  const fnRef = useRef(fn);
  fnRef.current = fn;
  const fnInputsRef = useRef("");
  // The newest request; an answer to an older one is dropped.
  const requestRef = useRef(0);
  const mountedRef = useRef(true);
  const [clientId] = useState(() => crypto.randomUUID());
  // Keep the requested intent even while a previous function is still visible.
  const requestedRef = useRef<RequestedFunction | null>(null);
  const inputsKeyForRef = useRef(inputsKeyFor);
  inputsKeyForRef.current = inputsKeyFor;
  const scrollSeq = useRef(0);

  const reveal = useCallback((line: number, how: Reveal) => {
    if (how === "keep") return;
    setScrollTarget({ line, seq: ++scrollSeq.current, nav: how === "nav" });
  }, []);

  const load = useCallback(
    async (address: bigint, how: Reveal) => {
      if (!decompile || !canLoad) return;
      const request = ++requestRef.current;
      const inputsKey = inputsKeyForRef.current?.(address) ?? "";
      requestedRef.current = { address, how, inputsKey, pending: true };
      setBusy(how === "keep" ? "refresh" : "load");
      const started = performance.now();
      const stopWatching = perfWatchWait("ui.pseudocode.waiting");
      let outcome: DecompileOutcome;
      try {
        outcome = await decompile(formatAddress(address), { id: clientId, sequence: request });
      } catch (e) {
        // The process going away is the Stopped transition, not a failure.
        const message = formatTauriError(e);
        outcome = isBenignSessionError(message) ? { status: "no_function" } : { status: "failed", message };
      } finally {
        stopWatching();
      }
      const dropped = !mountedRef.current || request !== requestRef.current || inputsKey !== (inputsKeyForRef.current?.(address) ?? "");
      perfRecord("ui.pseudocode.load", started, performance.now() - started, {
        outcome: OUTCOME_CODE[outcome.status],
        dropped: dropped ? 1 : 0,
        refresh: how === "keep" ? 1 : 0,
      });
      if (dropped) return;
      requestedRef.current!.pending = false;
      setBusy(null);
      // A current superseded outcome has no later local answer to wait for.
      if (outcome.status === "superseded") return;
      if (outcome.status !== "ok") {
        setResult({ fn: null, status: outcome.status, error: outcome.status === "failed" ? outcome.message : null });
        setScrollTarget(null);
        return;
      }
      // Re-index every answer: identical text can have new bounds and mappings.
      // Keep only the text array when equal, so selection/highlighting stay put.
      const loaded = indexFunction(outcome);
      const current = fnRef.current;
      if (current && current.code === loaded.code) loaded.lines = current.lines;
      fnInputsRef.current = inputsKey;
      setResult({ ...NOTHING, fn: loaded });
      reveal(lineForAddress(loaded, address), how);
    },
    [decompile, canLoad, clientId, reveal],
  );

  /** Show the function containing `address`, on the line of that instruction. */
  const show = useCallback(
    (address: bigint, how: Reveal = "plain") => {
      const current = fnRef.current;
      if (current && contains(current, address)) {
        // An answer still on its way would replace the function this is in.
        requestRef.current++;
        setBusy(null);
        requestedRef.current = {
          address,
          how,
          inputsKey: fnInputsRef.current,
          pending: false,
        };
        reveal(lineForAddress(current, address), how);
        return;
      }
      void load(address, how);
    },
    [load, reveal],
  );

  /** Refresh the requested target, not the old function visible behind a load. */
  const refresh = useCallback(() => {
    const requested = requestedRef.current;
    if (!requested) return;
    const current = fnRef.current;
    const how = requested.pending || !current || !contains(current, requested.address) ? requested.how : "keep";
    void load(requested.address, how);
  }, [load]);

  // Declared before the PC-follow effect: a navigation waiting for this view
  // to mount is what it should open on, not the PC.
  const openedByNavigation = useRef(false);
  useNavigationChannel(navigation, ({ address }) => {
    if (!decompile || !canLoad) return;
    openedByNavigation.current = true;
    show(BigInt(address), "nav");
  }, (payload) => payload.scope === pseudocodeScope);

  // Follow the instruction pointer.
  const lastPcRef = useRef<bigint | null>(null);
  useEffect(() => {
    // Navigation wins only this commit, including when the PC is unchanged.
    const navigated = openedByNavigation.current;
    openedByNavigation.current = false;
    if (pcAddress == null) {
      lastPcRef.current = null;
      return;
    }
    if (!decompile || !canLoad || pcAddress === lastPcRef.current) return;
    lastPcRef.current = pcAddress;
    if (followPc && !navigated) show(pcAddress);
  });

  // A host with no PC opens on its initial address.
  useEffect(() => {
    if (!decompile || !canLoad || initialAddress == null) return;
    if (requestedRef.current === null && fnRef.current === null) show(initialAddress);
  }, [decompile, canLoad, initialAddress, show]);

  // Metadata belongs to the requested target, including the very first load.
  // Reading the ref each commit also covers navigation/PC effects above, which
  // can replace that target without changing the function currently on screen.
  useEffect(() => {
    const requested = requestedRef.current;
    if (requested && requested.inputsKey !== (inputsKeyForRef.current?.(requested.address) ?? "")) refresh();
  });

  // No process (or no file): nothing here is valid any more.
  useEffect(() => {
    if (decompile && canLoad) return;
    requestRef.current++;
    requestedRef.current = null;
    lastPcRef.current = null;
    setResult(NOTHING);
    setBusy(null);
    setScrollTarget(null);
  }, [decompile, canLoad]);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const pcLine = useMemo(() => {
    if (!fn || pcAddress == null || !contains(fn, pcAddress)) return null;
    return lineForAddress(fn, pcAddress);
  }, [fn, pcAddress]);

  const toggleFollowPc = useCallback(() => {
    setFollowPc(!followPc);
    if (!followPc && pcAddress != null) show(pcAddress);
  }, [followPc, pcAddress, show]);

  return {
    fn,
    status,
    error,
    isLoading: busy === "load",
    isBusy: busy !== null,
    pcLine,
    navLine: scrollTarget?.nav ? scrollTarget.line : null,
    scrollTarget,
    followPc,
    toggleFollowPc,
    refresh,
  };
}
