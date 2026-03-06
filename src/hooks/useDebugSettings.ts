import { useEffect, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface DebugSettings {
  stop_on_thread_create: boolean;
  stop_on_thread_exit: boolean;
  stop_on_dll_load: boolean;
  stop_on_dll_unload: boolean;
  stop_on_initial_breakpoint: boolean;
  stop_on_process_create: boolean;
}

export interface EventSettingItem {
  key: keyof DebugSettings;
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
];

const DEFAULTS: DebugSettings = {
  stop_on_thread_create: true,
  stop_on_thread_exit: false,
  stop_on_dll_load: true,
  stop_on_dll_unload: true,
  stop_on_initial_breakpoint: true,
  stop_on_process_create: true,
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

  const toggle = useCallback(async (key: keyof DebugSettings) => {
    let next!: DebugSettings;
    setSettings(prev => {
      next = { ...prev, [key]: !prev[key] };
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

  return { settings, toggle };
}
