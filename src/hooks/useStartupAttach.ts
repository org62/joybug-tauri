import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toastSuccess } from "@/lib/logger";
import { reportSessionError, type ProcessInfo } from "@/lib/sessionHelpers";

interface StartupAttach {
  pid: number;
  event_handle: number;
}

/**
 * A Windows JIT (AeDebug) launch: the OS started this Joybug with
 * `-p <pid> -e <handle>` for a process that just crashed. Attach to it straight
 * away and open the session. The backend hands the pair out once, so a UI
 * reload cannot attach twice.
 */
export function useStartupAttach(navigate: (path: string) => void) {
  // StrictMode double-mounts in dev; the backend take() also guards this.
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    (async () => {
      const attach = await invoke<StartupAttach | null>("get_startup_attach").catch((e) => {
        console.error("Failed to read startup attach:", e);
        return null;
      });
      if (!attach) return;

      try {
        // The image name keys persisted breakpoints/patches, same as a manual
        // attach; fall back to the pid if the process can't be listed.
        const list = await invoke<ProcessInfo[]>("list_processes", { serverUrl: null }).catch((e) => {
          console.warn("Could not resolve the crashed process name:", e);
          return [] as ProcessInfo[];
        });
        const name = list.find((p) => p.pid === attach.pid)?.name ?? `pid ${attach.pid}`;

        const sessionId = await invoke<string>("create_debug_session", {
          name: `JIT: ${name} (${attach.pid})`,
          serverUrl: "",
          launchCommand: name,
          workingDirectory: null,
          isLocalRun: true,
          attachPid: attach.pid,
          nonInvasive: false,
          jitEventHandle: attach.event_handle,
        });
        await invoke("start_debug_session", { sessionId });
        void toastSuccess(`Attaching to crashed process ${attach.pid}`);
        navigate(`/session/${sessionId}`);
      } catch (e) {
        reportSessionError(`attach to crashed process ${attach.pid}`, e);
      }
    })();
  }, [navigate]);
}
