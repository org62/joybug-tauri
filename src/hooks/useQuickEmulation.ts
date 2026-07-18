import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useLocalStorageState } from "./useLocalStorageState";

interface EmulationInstructionInfo {
  address: string;
  symbol: string | null;
  mnemonic: string;
  op_str: string;
}

interface MemorySnapshotEntry {
  address: string;
  data: number[];
}

export interface QuickEmulationResult {
  session_id: string;
  request_id: string | null;
  mode: string;
  final_pc: string | null;
  instructions_executed: number;
  stop_reason: string;
  emulation_time_us: number;
  pages_loaded: number | null;
  basic_blocks: string[];
  trace_text: string | null;
  trace_time_us: number | null;
  instruction_info: EmulationInstructionInfo[];
  stats_text: string;
  memory_snapshots: MemorySnapshotEntry[];
}

export type TraceMode = "InstructionTrace" | "BasicBlock";

export interface QuickEmulationState {
  syscallResult: QuickEmulationResult | null;
  moduleResult: QuickEmulationResult | null;
  traceResult: QuickEmulationResult | null;
  /** Addresses executed by the trace run, keyed like breakpointAddresses
   *  (uppercase hex); null when no real coverage is available. */
  executedAddresses: Set<string> | null;
  traceMode: TraceMode;
  maxInstructions: number;
  setMaxInstructions: (value: number) => void;
  isLoading: boolean;
  toggleTraceMode: () => void;
  collapsed: boolean;
  toggleCollapsed: () => void;
}

const DEBOUNCE_MS = 150;
const MAX_INSTRUCTIONS_KEY = "assembly-quick-emulation-max-instructions";
const COLLAPSED_KEY = "assembly-quick-emulation-collapsed";
const DEFAULT_MAX_INSTRUCTIONS = 10000;

export function useQuickEmulation(
  sessionId: string | undefined,
  isPaused: boolean | undefined,
  pcAddress?: number,
): QuickEmulationState {
  const [syscallResult, setSyscallResult] = useState<QuickEmulationResult | null>(null);
  const [moduleResult, setModuleResult] = useState<QuickEmulationResult | null>(null);
  const [traceResult, setTraceResult] = useState<QuickEmulationResult | null>(null);
  const [traceMode, setTraceMode] = useState<TraceMode>("InstructionTrace");
  const [maxInstructions, setMaxInstructionsPersisted] = useLocalStorageState(MAX_INSTRUCTIONS_KEY, DEFAULT_MAX_INSTRUCTIONS);
  const [isLoading, setIsLoading] = useState(false);
  const [collapsed, setCollapsed] = useLocalStorageState(COLLAPSED_KEY, false);

  // Track current request timestamp to ignore stale results
  const currentTsRef = useRef<string>("");
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const maxInstructionsRef = useRef(maxInstructions);

  // Fire all 3 emulation requests
  const fireRequests = useCallback((currentTraceMode: TraceMode) => {
    if (!sessionId) return;

    const cap = maxInstructionsRef.current;
    const ts = Date.now().toString();
    currentTsRef.current = ts;
    setIsLoading(true);

    const syscallId = `quick-syscall-${ts}`;
    const modtransId = `quick-modtrans-${ts}`;
    const traceId = `quick-trace-${ts}`;

    invoke("request_emulation", {
      sessionId,
      maxInstructions: cap,
      mode: "Syscall",
      exitAddress: null,
      requestId: syscallId,
    }).catch(() => {});

    invoke("request_emulation", {
      sessionId,
      maxInstructions: cap,
      mode: "ModuleTransition",
      exitAddress: null,
      requestId: modtransId,
    }).catch(() => {});

    invoke("request_emulation", {
      sessionId,
      maxInstructions: cap,
      mode: currentTraceMode,
      exitAddress: null,
      requestId: traceId,
    }).catch(() => {});
  }, [sessionId]);
  const setMaxInstructions = useCallback((value: number) => {
    const clamped = Math.max(100, value);
    maxInstructionsRef.current = clamped;
    setMaxInstructionsPersisted(clamped);
  }, [setMaxInstructionsPersisted]);

  // Listen for emulation-result events filtered by quick- prefix
  useEffect(() => {
    const unlistenResult = listen<QuickEmulationResult>("emulation-result", (event) => {
      const rid = event.payload.request_id;
      if (!rid?.startsWith("quick-")) return;
      if (sessionId && event.payload.session_id !== sessionId) return;

      // Extract timestamp from request_id to ignore stale results
      const parts = rid.split("-");
      const ts = parts[parts.length - 1];
      if (ts !== currentTsRef.current) return;

      if (rid.startsWith("quick-syscall-")) {
        setSyscallResult(event.payload);
      } else if (rid.startsWith("quick-modtrans-")) {
        setModuleResult(event.payload);
      } else if (rid.startsWith("quick-trace-")) {
        setTraceResult(event.payload);
      }

      // Check if all 3 are done (we'll clear loading when trace arrives since it's last/slowest)
      // Simple approach: clear loading on each arrival; the spinner is mostly for UX
      setIsLoading(false);
    });

    const unlistenError = listen<{ session_id: string; error: string }>("emulation-error", () => {
      setIsLoading(false);
    });

    return () => {
      unlistenResult.then(f => f());
      unlistenError.then(f => f());
    };
  }, [sessionId]);

  // Clear state when session ends or resumes (not paused anymore)
  useEffect(() => {
    if (!sessionId || !isPaused) {
      setSyscallResult(null);
      setModuleResult(null);
      setTraceResult(null);
      setIsLoading(false);
      currentTsRef.current = "";
    }
  }, [sessionId, isPaused]);

  // Auto-fire when paused and PC changes (covers both pause transitions and stepping)
  useEffect(() => {
    if (!isPaused || collapsed || !sessionId) return;

    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => {
      fireRequests(traceMode);
    }, DEBOUNCE_MS);

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    };
  }, [isPaused, sessionId, collapsed, pcAddress, fireRequests, traceMode, maxInstructions]);

  // Collapsing discards results in the same render batch, so consumers
  // (executed-row highlighting) clear immediately; expanding re-fires the
  // requests via the auto-fire effect above.
  const toggleCollapsed = useCallback(() => {
    const next = !collapsed;
    setCollapsed(next);
    if (next) {
      setSyscallResult(null);
      setModuleResult(null);
      setTraceResult(null);
      setIsLoading(false);
      currentTsRef.current = "";
    }
  }, [collapsed, setCollapsed]);

  const toggleTraceMode = useCallback(() => {
    const next = traceMode === "InstructionTrace" ? "BasicBlock" : "InstructionTrace";
    setTraceMode(next);
    // A mode flip invalidates the current trace — re-fire with the new mode.
    if (sessionId && isPaused && !collapsed) {
      setTraceResult(null);
      fireRequests(next);
    }
  }, [traceMode, sessionId, isPaused, collapsed, fireRequests]);

  // Addresses executed by the trace run, keyed like breakpointAddresses
  // (uppercase hex). Only the full instruction trace gives real coverage —
  // BasicBlock results carry block starts only, which would read as gaps.
  const executedAddresses = useMemo(() => {
    if (!traceResult || traceResult.mode !== "InstructionTrace") return null;
    return new Set(traceResult.instruction_info.map((i) => i.address.toUpperCase()));
  }, [traceResult]);

  // Stable identity so memoized consumers (EmulationQuickView) can bail out.
  return useMemo(() => ({
    syscallResult,
    moduleResult,
    traceResult,
    executedAddresses,
    traceMode,
    maxInstructions,
    setMaxInstructions,
    isLoading,
    toggleTraceMode,
    collapsed,
    toggleCollapsed,
  }), [syscallResult, moduleResult, traceResult, executedAddresses, traceMode, maxInstructions, setMaxInstructions, isLoading, toggleTraceMode, collapsed, toggleCollapsed]);
}
