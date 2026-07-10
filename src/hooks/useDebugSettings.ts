import { useEffect, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface ExceptionRule {
  code: number;
  first_chance: string;  // "stop" | "pass" | "handled"
  second_chance: string; // "stop" | "pass" | "handled"
}

export interface DebuggerHidingSettings {
  hide_from_peb: boolean;
  being_debugged: boolean;
  heap_flags: boolean;
  nt_global_flag: boolean;
  startup_info: boolean;
  os_build_number: boolean;
}

export interface DebugSettings {
  stop_on_thread_create: boolean;
  stop_on_thread_exit: boolean;
  stop_on_dll_load: boolean;
  stop_on_dll_unload: boolean;
  stop_on_initial_breakpoint: boolean;
  stop_on_process_create: boolean;
  stop_on_debug_output: boolean;
  exception_rules: ExceptionRule[];
  debugger_hiding: DebuggerHidingSettings;
  scan_thread_count: number; // 0 = all CPU cores
  symbol_path: string; // _NT_SYMBOL_PATH syntax; empty = env var / Microsoft symbol server
  symbol_offline: boolean; // never download symbols
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
  { key: "stop_on_thread_create", id: "event.threadCreate", label: "Thread Create", keywords: ["event", "thread", "create", "exception"] },
  { key: "stop_on_thread_exit", id: "event.threadExit", label: "Thread Exit", keywords: ["event", "thread", "exit", "exception"] },
  { key: "stop_on_dll_load", id: "event.dllLoad", label: "DLL Load", keywords: ["event", "dll", "module", "load", "exception"] },
  { key: "stop_on_dll_unload", id: "event.dllUnload", label: "DLL Unload", keywords: ["event", "dll", "module", "unload", "exception"] },
  { key: "stop_on_initial_breakpoint", id: "event.initialBreakpoint", label: "Initial Breakpoint", keywords: ["event", "breakpoint", "initial", "launch", "attach", "exception"] },
  { key: "stop_on_debug_output", id: "event.debugOutput", label: "Debug Output (OutputDebugString)", keywords: ["event", "output", "debug", "string", "print"] },
];

const DEFAULT_HIDING: DebuggerHidingSettings = {
  hide_from_peb: false,
  being_debugged: true,
  heap_flags: true,
  nt_global_flag: true,
  startup_info: true,
  os_build_number: true,
};

const DEFAULTS: DebugSettings = {
  stop_on_thread_create: true,
  stop_on_thread_exit: false,
  stop_on_dll_load: true,
  stop_on_dll_unload: true,
  stop_on_initial_breakpoint: true,
  stop_on_process_create: true,
  stop_on_debug_output: false,
  exception_rules: [],
  debugger_hiding: DEFAULT_HIDING,
  scan_thread_count: 0,
  symbol_path: "",
  symbol_offline: false,
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

  const toggleHiding = useCallback((key: keyof DebuggerHidingSettings) =>
    update(prev => {
      const hiding = { ...(prev.debugger_hiding ?? DEFAULT_HIDING), [key]: !(prev.debugger_hiding ?? DEFAULT_HIDING)[key] };
      return { ...prev, debugger_hiding: hiding };
    }), [update]);

  const setScanThreadCount = useCallback((count: number) => {
    const sanitized = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
    return update(prev => ({ ...prev, scan_thread_count: sanitized }));
  }, [update]);

  const setSymbolPath = useCallback((path: string) =>
    update(prev => ({ ...prev, symbol_path: path })), [update]);

  return { settings, toggle, updateExceptionRules, toggleHiding, setScanThreadCount, setSymbolPath };
}
