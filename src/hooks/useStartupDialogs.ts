import { useCallback, useEffect, useRef, useState } from "react";
import {
  getWelcomeState,
  startupUpdateCheck,
  type UpdateInfo,
  type WelcomeState,
} from "@/lib/updates";

/**
 * Sequences the two things that can pop up on launch: the first-run beta
 * dialog and the automatic update prompt.
 *
 * They never stack — the welcome dialog wins, and the update check is deferred
 * until it's dismissed. All failures are swallowed to the console: neither of
 * these is something the user asked for, so neither should interrupt startup.
 */
export function useStartupDialogs() {
  const [welcome, setWelcome] = useState<WelcomeState | null>(null);
  // The update dialog's visibility *is* "do we have an update to offer", so
  // there's no separate open flag.
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  // StrictMode double-mounts in dev; without this the check fires twice.
  const startedRef = useRef(false);

  const runUpdateCheck = useCallback(async () => {
    try {
      const info = await startupUpdateCheck();
      if (info) setUpdate(info);
    } catch (e) {
      console.error("Startup update check failed:", e);
    }
  }, []);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    (async () => {
      try {
        const state = await getWelcomeState();
        if (state.should_show) {
          setWelcome(state);
          return; // update check resumes from dismissWelcome()
        }
      } catch (e) {
        console.error("Failed to read welcome state:", e);
      }
      await runUpdateCheck();
    })();
  }, [runUpdateCheck]);

  const dismissWelcome = useCallback(() => {
    setWelcome(null);
    void runUpdateCheck();
  }, [runUpdateCheck]);

  const dismissUpdate = useCallback(() => setUpdate(null), []);

  return { welcome, dismissWelcome, update, dismissUpdate };
}
