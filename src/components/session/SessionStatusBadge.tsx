import { Badge } from "@/components/ui/badge";
import type { SessionStatus } from "@/contexts/SessionContext";

/**
 * Session status badge shared by the sessions list (Debugger) and the docked
 * session view. The `data-session-status` attribute is a test contract — the
 * e2e suite waits on `[data-session-status="Paused"]` (e2e/helpers/
 * wait-helpers.ts) — so restyles must keep the attribute intact.
 */
export function SessionStatusBadge({
  status,
  openLabel = "Open",
}: {
  status: SessionStatus;
  openLabel?: string;
}) {
  if (typeof status !== "string") {
    return <Badge data-session-status="Error" variant="destructive">Error</Badge>;
  }
  switch (status) {
    case "Stopped":
      return <Badge data-session-status="Stopped" variant="secondary">Stopped</Badge>;
    case "Running":
      return <Badge data-session-status="Running" variant="outline" className="animate-pulse">Running</Badge>;
    case "Paused":
      return <Badge data-session-status="Paused" variant="outline" className="bg-syn-state/15 text-syn-state border-syn-state/30">Paused</Badge>;
    case "Open":
      return <Badge data-session-status="Open" variant="outline">{openLabel}</Badge>;
    default:
      return <Badge data-session-status={status} variant="secondary">{status}</Badge>;
  }
}
