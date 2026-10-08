import { useEffect, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface ExceptionRule {
  code: number;
  first_chance: string;  // "stop" | "pass" | "handled"
  second_chance: string; // "stop" | "pass" | "handled"
}

export interface PebNormalizeSettings {
  enabled: boolean;
  being_debugged: boolean;
  heap_flags: boolean;
}

export interface DebugSettings {
  stop_on_thread_create: boolean;
  stop_on_thread_exit: boolean;
  stop_on_dll_load: boolean;
  stop_on_dll_unload: boolean;
  stop_on_initial_breakpoint: boolean;
  stop_on_process_create: boolean;
  stop_on_process_exit: boolean;
  stop_on_debug_output: boolean;
  break_on_user_module_entry: boolean;
  break_on_system_module_entry: boolean;
  break_on_user_tls_callbacks: boolean;
  break_on_system_tls_callbacks: boolean;
  exception_rules: ExceptionRule[];
  capture_exception_context: boolean; // symbolize + walk the stack for every exception, not just stopping ones
  peb_normalize: PebNormalizeSettings;
  scan_thread_count: number; // 0 = all CPU cores
  symbol_path: string; // _NT_SYMBOL_PATH syntax; empty = env var / Microsoft symbol server
  symbol_offline: boolean; // never download symbols
  auto_update_check: boolean; // ask GitHub Releases for a newer version on startup
  lightning_instructions: number; // instructions the always-on lightning emulation runs per pause
  sandbox_default_memory_mb: number; // default guest memory (MB) for new sandbox sessions
  sandbox_collect_etw: boolean; // default "collect ETW trace" for new sandbox sessions
  sandbox_etw_preset: string; // default ETW capture preset: "all" | "files" | "registry" | "network"
}

// Keys whose value is a boolean, derived structurally so new settings never
// require editing a hand-maintained exclusion list.
type BooleanSettingKey = { [K in keyof DebugSettings]: DebugSettings[K] extends boolean ? K : never }[keyof DebugSettings];

export interface EventSettingItem {
  key: BooleanSettingKey;
  id: string;
  label: string;
  keywords: string[];
}

export const EVENT_ITEMS: EventSettingItem[] = [
  { key: "stop_on_process_create", id: "event.processCreate", label: "Process Create", keywords: ["event", "process", "create", "exception"] },
  { key: "stop_on_process_exit", id: "event.processExit", label: "Process Exit", keywords: ["event", "process", "exit", "terminate", "exception"] },
  { key: "stop_on_thread_create", id: "event.threadCreate", label: "Thread Create", keywords: ["event", "thread", "create", "exception"] },
  { key: "stop_on_thread_exit", id: "event.threadExit", label: "Thread Exit", keywords: ["event", "thread", "exit", "exception"] },
  { key: "stop_on_dll_load", id: "event.dllLoad", label: "Module Load", keywords: ["event", "dll", "so", "library", "module", "load", "exception"] },
  { key: "stop_on_dll_unload", id: "event.dllUnload", label: "Module Unload", keywords: ["event", "dll", "so", "library", "module", "unload", "exception"] },
  { key: "stop_on_initial_breakpoint", id: "event.initialBreakpoint", label: "Initial Breakpoint", keywords: ["event", "breakpoint", "initial", "launch", "attach", "exception"] },
  { key: "stop_on_debug_output", id: "event.debugOutput", label: "Debug Output (OutputDebugString)", keywords: ["event", "output", "debug", "string", "print"] },
  { key: "break_on_user_module_entry", id: "event.moduleEntryUser", label: "Module Entry (user modules)", keywords: ["event", "module", "entry", "point", "dllmain", "oep", "break", "breakpoint", "user", "single-shot"] },
  { key: "break_on_system_module_entry", id: "event.moduleEntrySystem", label: "Module Entry (system modules)", keywords: ["event", "module", "entry", "point", "dllmain", "oep", "break", "breakpoint", "system", "system32", "syswow64", "single-shot"] },
  { key: "break_on_user_tls_callbacks", id: "event.tlsCallbacksUser", label: "TLS Callbacks (user modules)", keywords: ["event", "tls", "callback", "break", "breakpoint", "user", "single-shot"] },
  { key: "break_on_system_tls_callbacks", id: "event.tlsCallbacksSystem", label: "TLS Callbacks (system modules)", keywords: ["event", "tls", "callback", "break", "breakpoint", "system", "system32", "syswow64", "single-shot"] },
  { key: "capture_exception_context", id: "event.exceptionContext", label: "Capture callstack & symbols for non-stopping exceptions", keywords: ["event", "exception", "callstack", "stack", "symbol", "symbolize", "pass", "handled", "log"] },
];

const DEFAULT_PEB_NORMALIZE: PebNormalizeSettings = {
  enabled: false,
  being_debugged: true,
  heap_flags: true,
};

const DEFAULTS: DebugSettings = {
  stop_on_thread_create: true,
  stop_on_thread_exit: false,
  stop_on_dll_load: true,
  stop_on_dll_unload: true,
  stop_on_initial_breakpoint: true,
  stop_on_process_create: true,
  stop_on_process_exit: false,
  stop_on_debug_output: false,
  break_on_user_module_entry: false,
  break_on_system_module_entry: false,
  break_on_user_tls_callbacks: false,
  break_on_system_tls_callbacks: false,
  exception_rules: [],
  capture_exception_context: true,
  peb_normalize: DEFAULT_PEB_NORMALIZE,
  scan_thread_count: 0,
  symbol_path: "",
  symbol_offline: false,
  auto_update_check: true,
  lightning_instructions: 100,
  sandbox_default_memory_mb: 4096,
  sandbox_collect_etw: true,
  sandbox_etw_preset: "all",
};

export function useDebugSettings() {
  const [settings, setSettings] = useState<DebugSettings>(DEFAULTS);

  const load = useCallback(async () => {
    try {
      const s = await invoke<DebugSettings>("get_debug_settings");
      setSettings(s);
    } catch (e) {
      console.error("Failed to load debug settings:", e);
    }
  }, []);

  // Shared set-and-persist: apply the change optimistically, then write the
  // whole settings object to the backend.
  const update = useCallback(async (updater: (prev: DebugSettings) => DebugSettings) => {
    let next!: DebugSettings;
    setSettings(prev => {
      next = updater(prev);
      return next;
    });
    try {
      await invoke("update_debug_settings", { newSettings: next });
    } catch (e) {
      console.error("Failed to update debug settings:", e);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const toggle = useCallback((key: BooleanSettingKey) =>
    update(prev => ({ ...prev, [key]: !prev[key] })), [update]);

  const updateExceptionRules = useCallback((rules: ExceptionRule[]) =>
    update(prev => ({ ...prev, exception_rules: rules })), [update]);

  const togglePebNormalize = useCallback((key: keyof PebNormalizeSettings) =>
    update(prev => {
      const pebNormalize = { ...(prev.peb_normalize ?? DEFAULT_PEB_NORMALIZE), [key]: !(prev.peb_normalize ?? DEFAULT_PEB_NORMALIZE)[key] };
      return { ...prev, peb_normalize: pebNormalize };
    }), [update]);

  const setScanThreadCount = useCallback((count: number) => {
    const sanitized = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
    return update(prev => ({ ...prev, scan_thread_count: sanitized }));
  }, [update]);

  const setLightningInstructions = useCallback((count: number) => {
    const sanitized = Number.isFinite(count) && count >= 1 ? Math.floor(count) : 100;
    return update(prev => ({ ...prev, lightning_instructions: sanitized }));
  }, [update]);

  const setSymbolPath = useCallback((path: string) =>
    update(prev => ({ ...prev, symbol_path: path })), [update]);

  const setSandboxMemoryMb = useCallback((mb: number) => {
    const sanitized = Number.isFinite(mb) && mb >= 1024 ? Math.floor(mb) : 4096;
    return update(prev => ({ ...prev, sandbox_default_memory_mb: sanitized }));
  }, [update]);

  const setSandboxEtwPreset = useCallback((preset: string) =>
    update(prev => ({ ...prev, sandbox_etw_preset: preset })), [update]);

  return { settings, toggle, updateExceptionRules, togglePebNormalize, setScanThreadCount, setSymbolPath, setLightningInstructions, setSandboxMemoryMb, setSandboxEtwPreset };
}
