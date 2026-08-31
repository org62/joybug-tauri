import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/** Windows Sandbox availability (mirrors the Rust `SandboxAvailability`). */
export interface SandboxStatus {
  supported: boolean;
  build: number;
  wsb_present: boolean;
  reason: string | null;
}

/** Whether the sandbox run mode is usable right now. */
export function isSandboxAvailable(status: SandboxStatus | null): boolean {
  return !!status && status.supported && status.wsb_present;
}

/**
 * Read-only availability of the Windows Sandbox run mode (OS build, wsb.exe
 * present, guest binaries embedded). Mirrors `useJitDebugger`'s status shape;
 * there is no enable path — availability is an OS/build fact.
 */
export function useSandbox() {
  const [status, setStatus] = useState<SandboxStatus | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await invoke<SandboxStatus>("get_sandbox_status"));
    } catch (e) {
      console.error("Failed to read sandbox status:", e);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { status, refresh, available: isSandboxAvailable(status) };
}
