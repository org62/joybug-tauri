import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useLocalStorageState } from "./useLocalStorageState";
import { useDebugSettings } from "./useDebugSettings";
import { buildTraceSteps, indexTraceByAddress, type RowTrace } from "@/lib/emulationTrace";

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

/** Footer trace granularity. `Calls` is a client-side view over an
 *  instruction trace (call/ret destinations), so it shares the
 *  `InstructionTrace` backend mode. */
export type TraceMode = "InstructionTrace" | "BasicBlock" | "Calls";
const TRACE_MODE_CYCLE: TraceMode[] = ["InstructionTrace", "BasicBlock", "Calls"];
export function backendTraceMode(mode: TraceMode): "InstructionTrace" | "BasicBlock" {
  return mode === "BasicBlock" ? "BasicBlock" : "InstructionTrace";
}

/** The three optional Quick Emulation probes, each switchable on its own. */
export type EmulationToggle = "module" | "syscall" | "instructions";
export type EmulationToggles = Record<EmulationToggle, boolean>;

/** What the always-on lightning run did, shaped for the disassembly rows. */
export interface LightningTrace {
  byAddress: Map<string, RowTrace>;
  /** Where emulation stopped (uppercase hex) — the instruction that would run next. */
  finalPc: string | null;
}

export interface QuickEmulationState {
  syscallResult: QuickEmulationResult | null;
  moduleResult: QuickEmulationResult | null;
  traceResult: QuickEmulationResult | null;
  lightning: LightningTrace | null;
  toggles: EmulationToggles;
  setToggle: (name: EmulationToggle, on: boolean) => void;
  /** The always-on lightning run can be switched off per user (…-menu). */
  lightningEnabled: boolean;
  setLightningEnabled: (on: boolean) => void;
  traceMode: TraceMode;
  maxInstructions: number;
  setMaxInstructions: (value: number) => void;
  isLoading: boolean;
  toggleTraceMode: () => void;
}

// Emulation fires only after the view settles at a location — long enough
// that active stepping (and the disassembly refresh each step triggers) never
// races it. Emulation is a "what happens if I sit here" tool; firing it 150ms
// after every step both wasted work mid-stepping and competed with the post-step
// disassembly render. The debounce resets on every PC change, so a run of steps
// fires zero emulations until the user pauses to look.
const DEBOUNCE_MS = 400;
const MAX_INSTRUCTIONS_KEY = "assembly-quick-emulation-max-instructions";
const TOGGLES_KEY = "assembly-quick-emulation-toggles";
/** Lightning off-switch. Also what the e2e fixture sets (as `"true"`, which
 *  parses to boolean `true`) so the per-pause run costs nothing in specs that
 *  don't test it. */
const LIGHTNING_DISABLED_KEY = "assembly-lightning-disabled";
const DEFAULT_MAX_INSTRUCTIONS = 10000;
const DEFAULT_TOGGLES: EmulationToggles = { module: false, syscall: false, instructions: false };

type Probe = "lightning" | "syscall" | "module" | "trace";

export function useQuickEmulation(
  sessionId: string | undefined,
  isPaused: boolean | undefined,
  pcAddress?: number,
  // Whether the always-on probes may auto-fire on each pause/step. Off for
  // sandbox (and other high-latency remote) sessions, where emulation is
  // server-side work reached over a slow TCP link — auto-firing it stalled every
  // step by ~8s. Manual toggles still fire once, user-initiated.
  autoEmulate: boolean = true,
): QuickEmulationState {
  const [syscallResult, setSyscallResult] = useState<QuickEmulationResult | null>(null);
  const [moduleResult, setModuleResult] = useState<QuickEmulationResult | null>(null);
  const [traceResult, setTraceResult] = useState<QuickEmulationResult | null>(null);
  const [lightningResult, setLightningResult] = useState<QuickEmulationResult | null>(null);
  const [traceMode, setTraceMode] = useState<TraceMode>("InstructionTrace");
  const [maxInstructions, setMaxInstructionsPersisted] = useLocalStorageState(MAX_INSTRUCTIONS_KEY, DEFAULT_MAX_INSTRUCTIONS);
  const [storedToggles, setStoredToggles] = useLocalStorageState<Partial<EmulationToggles>>(TOGGLES_KEY, DEFAULT_TOGGLES);
  const toggles = useMemo<EmulationToggles>(() => ({ ...DEFAULT_TOGGLES, ...storedToggles }), [storedToggles]);
  const [lightningDisabled, setLightningDisabled] = useLocalStorageState<boolean>(LIGHTNING_DISABLED_KEY, false);
  const lightningEnabled = !lightningDisabled;
  const lightningEnabledRef = useRef(lightningEnabled);
  lightningEnabledRef.current = lightningEnabled;
  const [isLoading, setIsLoading] = useState(false);
  const { settings } = useDebugSettings();
  const lightningInstructions = Math.max(1, settings.lightning_instructions || 100);

  // Track current request timestamp to ignore stale results
  const currentTsRef = useRef<string>("");
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const maxInstructionsRef = useRef(maxInstructions);
  const lightningInstructionsRef = useRef(lightningInstructions);
  lightningInstructionsRef.current = lightningInstructions;
  const togglesRef = useRef(toggles);
  togglesRef.current = toggles;
  const traceModeRef = useRef(traceMode);
  traceModeRef.current = traceMode;

  // Fire a set of probes under one timestamp. Results of older timestamps are
  // dropped, so a partial re-fire (a toggle flipped on) must reuse the current
  // timestamp or it would orphan the in-flight probes.
  const fireProbes = useCallback((probes: Probe[], reuseTs: boolean) => {
    if (!sessionId || probes.length === 0) return;

    const ts = reuseTs && currentTsRef.current ? currentTsRef.current : Date.now().toString();
    currentTsRef.current = ts;
    setIsLoading(true);

    const send = (probe: Probe, mode: string, maxInstructions: number) =>
      invoke("request_emulation", {
        sessionId,
        maxInstructions,
        mode,
        exitAddress: null,
        requestId: `quick-${probe}-${ts}`,
      }).catch(() => {});

    for (const probe of probes) {
      switch (probe) {
        case "lightning": send(probe, "InstructionTrace", lightningInstructionsRef.current); break;
        case "syscall": send(probe, "Syscall", maxInstructionsRef.current); break;
        case "module": send(probe, "ModuleTransition", maxInstructionsRef.current); break;
        case "trace": send(probe, backendTraceMode(traceModeRef.current), maxInstructionsRef.current); break;
      }
    }
  }, [sessionId]);

  const enabledProbes = useCallback((): Probe[] => {
    const t = togglesRef.current;
    const probes: Probe[] = [];
    if (lightningEnabledRef.current) probes.push("lightning");
    if (t.syscall) probes.push("syscall");
    if (t.module) probes.push("module");
    if (t.instructions) probes.push("trace");
    return probes;
  }, []);

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

      if (rid.startsWith("quick-lightning-")) {
        setLightningResult(event.payload);
      } else if (rid.startsWith("quick-syscall-")) {
        if (togglesRef.current.syscall) setSyscallResult(event.payload);
      } else if (rid.startsWith("quick-module-")) {
        if (togglesRef.current.module) setModuleResult(event.payload);
      } else if (rid.startsWith("quick-trace-")) {
        if (togglesRef.current.instructions) setTraceResult(event.payload);
      }

      // The spinner is mostly UX: clear it on each arrival.
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
      setLightningResult(null);
      setIsLoading(false);
      currentTsRef.current = "";
    }
  }, [sessionId, isPaused]);

  // Auto-fire when paused and PC changes (covers both pause transitions and
  // stepping). Suppressed when autoEmulate is off (sandbox/remote sessions).
  useEffect(() => {
    if (!isPaused || !sessionId || !autoEmulate) return;

    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => {
      fireProbes(enabledProbes(), false);
    }, DEBOUNCE_MS);

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    };
  }, [isPaused, sessionId, pcAddress, autoEmulate, fireProbes, enabledProbes, maxInstructions, lightningInstructions]);

  // Flipping a toggle off discards its result in the same render batch so the
  // footer clears instantly; flipping it on fires only that probe right away.
  const setToggle = useCallback((name: EmulationToggle, on: boolean) => {
    setStoredToggles((prev) => ({ ...DEFAULT_TOGGLES, ...prev, [name]: on }));
    togglesRef.current = { ...togglesRef.current, [name]: on };
    if (!on) {
      if (name === "syscall") setSyscallResult(null);
      if (name === "module") setModuleResult(null);
      if (name === "instructions") setTraceResult(null);
      return;
    }
    if (sessionId && isPaused) {
      fireProbes([name === "instructions" ? "trace" : name], true);
    }
  }, [setStoredToggles, sessionId, isPaused, fireProbes]);

  const toggleTraceMode = useCallback(() => {
    const next = TRACE_MODE_CYCLE[(TRACE_MODE_CYCLE.indexOf(traceMode) + 1) % TRACE_MODE_CYCLE.length];
    const backendChanged = backendTraceMode(next) !== backendTraceMode(traceMode);
    setTraceMode(next);
    traceModeRef.current = next;
    // Only a backend-mode change invalidates the current trace; Calls is a
    // view over the same instruction trace.
    if (backendChanged && sessionId && isPaused && togglesRef.current.instructions) {
      setTraceResult(null);
      fireProbes(["trace"], true);
    }
  }, [traceMode, sessionId, isPaused, fireProbes]);

  // Switching lightning off drops its annotations in the same render; on
  // fires the probe right away under the current timestamp.
  const setLightningEnabled = useCallback((on: boolean) => {
    setLightningDisabled(!on);
    lightningEnabledRef.current = on;
    if (!on) {
      setLightningResult(null);
    } else if (sessionId && isPaused) {
      fireProbes(["lightning"], true);
    }
  }, [setLightningDisabled, sessionId, isPaused, fireProbes]);

  // The lightning run, indexed by address for the disassembly rows.
  const lightning = useMemo<LightningTrace | null>(() => {
    if (!lightningResult) return null;
    return {
      byAddress: indexTraceByAddress(buildTraceSteps(lightningResult)),
      finalPc: lightningResult.final_pc ? lightningResult.final_pc.toUpperCase() : null,
    };
  }, [lightningResult]);

  // Stable identity so memoized consumers (EmulationQuickView) can bail out.
  return useMemo(() => ({
    syscallResult,
    moduleResult,
    traceResult,
    lightning,
    toggles,
    setToggle,
    lightningEnabled,
    setLightningEnabled,
    traceMode,
    maxInstructions,
    setMaxInstructions,
    isLoading,
    toggleTraceMode,
  }), [syscallResult, moduleResult, traceResult, lightning, toggles, setToggle, lightningEnabled, setLightningEnabled, traceMode, maxInstructions, setMaxInstructions, isLoading, toggleTraceMode]);
}
