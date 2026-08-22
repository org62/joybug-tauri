import { useSyncExternalStore } from "react";
import {
  getSessionRosterSnapshot,
  subscribeToSessionRoster,
  type SessionSummary,
} from "@/lib/sessionRoster";

/**
 * The id/name/status of every debug session, live-updated from the backend.
 * Backed by a single module-level store shared by every consumer — see
 * lib/sessionRoster.ts for why this isn't `useDebugSession`.
 */
export function useSessionRoster(): SessionSummary[] {
  return useSyncExternalStore(
    subscribeToSessionRoster,
    getSessionRosterSnapshot,
    getSessionRosterSnapshot,
  );
}

export type { SessionSummary };
