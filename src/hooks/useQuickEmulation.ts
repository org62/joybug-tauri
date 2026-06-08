import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

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
  traceMode: TraceMode;
  maxInstructions: number;
  setMaxInstructions: (value: number) => void;
  isLoading: boolean;
  toggleTraceMode: () => void;
}

const DEBOUNCE_MS = 150;
const MAX_INSTRUCTIONS_KEY = "assembly-quick-emulation-max-instructions";
const DEFAULT_MAX_INSTRUCTIONS = 10000;

function getInitialMaxInstructions(): number {
  try {
    const stored = localStorage.getItem(MAX_INSTRUCTIONS_KEY);
    if (stored) {
      const val = parseInt(stored, 10);
      if (!isNaN(val) && val > 0) return val;
    }
  } catch {}
  return DEFAULT_MAX_INSTRUCTIONS;
}

export function useQuickEmulation(
  sessionId: string | undefined,
  isPaused: boolean | undefined,
  collapsed: boolean,
  pcAddress?: number,
): QuickEmulationState {
  const [syscallResult, setSyscallResult] = useState<QuickEmulationResult | null>(null);
  const [moduleResult, setModuleResult] = useState<QuickEmulationResult | null>(null);
  const [traceResult, setTraceResult] = useState<QuickEmulationResult | null>(null);
  const [traceMode, setTraceMode] = useState<TraceMode>("InstructionTrace");
  const [maxInstructions, setMaxInstructionsState] = useState(getInitialMaxInstructions);
  const [isLoading, setIsLoading] = useState(false);

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
    setMaxInstructionsState(clamped);
    try { localStorage.setItem(MAX_INSTRUCTIONS_KEY, String(clamped)); } catch {}
  }, []);

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

  const toggleTraceMode = useCallback(() => {
    setTraceMode(prev => {
      const next = prev === "InstructionTrace" ? "BasicBlock" : "InstructionTrace";
      // Re-fire only the trace request with new mode
      if (sessionId && isPaused && !collapsed) {
        const ts = Date.now().toString();
        currentTsRef.current = ts;
        setTraceResult(null);
        setIsLoading(true);

        // Re-fire all 3 since timestamp changed
        const syscallId = `quick-syscall-${ts}`;
        const modtransId = `quick-modtrans-${ts}`;
        const traceId = `quick-trace-${ts}`;

        const cap = maxInstructionsRef.current;

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
          mode: next,
          exitAddress: null,
          requestId: traceId,
        }).catch(() => {});
      }
      return next;
    });
  }, [sessionId, isPaused, collapsed]);

  return {
    syscallResult,
    moduleResult,
    traceResult,
    traceMode,
    maxInstructions,
    setMaxInstructions,
    isLoading,
    toggleTraceMode,
  };
}
