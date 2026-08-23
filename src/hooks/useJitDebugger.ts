import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toastInfo, toastError, toastSuccess } from "@/lib/logger";
import { formatTauriError } from "@/lib/sessionHelpers";

export interface JitDebuggerStatus {
  /** AeDebug currently points at this Joybug exe. */
  registered: boolean;
  /** The raw `Debugger` value, whoever owns it; null when none is set. */
  current: string | null;
}

/**
 * A declined UAC prompt. `Error::JitDebuggerCancelled` is a *unit* variant, so
 * serde emits the bare string "JitDebuggerCancelled" rather than the
 * `{ Variant: message }` object the data-carrying variants produce — match on
 * the normalized message, the way `isBenignSessionError` does, so both shapes
 * are covered.
 */
function isElevationCancelled(err: unknown): boolean {
  return /JitDebuggerCancelled|Elevation was cancelled/i.test(formatTauriError(err));
}

/**
 * The Windows JIT (AeDebug) registration toggle. Registry-backed, not part of
 * `DebugSettings`: the state lives in HKLM and changing it goes through a UAC
 * prompt, so every write re-reads the real status instead of trusting the
 * optimistic value.
 */
export function useJitDebugger() {
  const [status, setStatus] = useState<JitDebuggerStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setStatus(await invoke<JitDebuggerStatus>("get_jit_debugger_status"));
    } catch (e) {
      console.error("Failed to read JIT debugger status:", e);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const setEnabled = useCallback(
    async (enable: boolean) => {
      setBusy(true);
      try {
        await invoke("set_jit_debugger", { enable });
        void toastSuccess(
          enable ? "Joybug is now the postmortem debugger" : "Previous postmortem debugger restored",
        );
      } catch (e) {
        if (isElevationCancelled(e)) {
          void toastInfo("Elevation cancelled — postmortem debugger unchanged");
        } else {
          void toastError(
            `Failed to ${enable ? "register" : "restore"} the postmortem debugger: ${formatTauriError(e)}`,
          );
        }
      } finally {
        setBusy(false);
        await refresh();
      }
    },
    [refresh],
  );

  return { status, busy, setEnabled };
}
