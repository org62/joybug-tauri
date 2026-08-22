import { useEffect, useRef, useState } from "react";
import type { SessionStatus } from "@/contexts/SessionContext";

/**
 * Debounced session status for display. Prevents UI flicker during quick
 * stepping, where the session bounces Paused → Running → Paused within a few
 * milliseconds.
 *
 * Paused / Stopped / Error apply immediately (a completed step should show its
 * results at once); only the transition *into* Running is delayed.
 *
 * Shared by useDebugSession (the session view) and the header's active-session
 * pill, so both settle on the same status at the same time.
 */
export function useDisplayStatus(actualStatus: SessionStatus | undefined): SessionStatus {
  const [displayStatus, setDisplayStatus] = useState<SessionStatus>("Stopped");
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Read the current display status without making it a dependency — the effect
  // must run on real status changes only, not on its own output.
  const displayRef = useRef<SessionStatus>(displayStatus);
  displayRef.current = displayStatus;

  useEffect(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }

    if (!actualStatus) {
      setDisplayStatus("Stopped");
      return;
    }

    // Immediate: reaching Paused (show step results now), Stopped (session
    // ended), Error, or coming from the initial Stopped state.
    if (
      actualStatus === "Paused" ||
      actualStatus === "Stopped" ||
      typeof actualStatus === "object" ||
      displayRef.current === "Stopped"
    ) {
      setDisplayStatus(actualStatus);
      return;
    }

    // Debounce Paused → Running so a burst of steps doesn't strobe.
    if (actualStatus === "Running" && displayRef.current === "Paused") {
      timeoutRef.current = setTimeout(() => setDisplayStatus("Running"), 250);
      return;
    }

    setDisplayStatus(actualStatus);
  }, [actualStatus]);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  return displayStatus;
}
