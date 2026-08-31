import { useSessionContext } from "@/contexts/SessionContext";
import { EtwEventsView } from "@/components/EtwEventsView";
import { canStopSession } from "@/lib/sessionHelpers";

export function ContextEtwEventsView() {
  const { session, processId } = useSessionContext();
  const isSandbox = !!session?.sandbox;
  // ETW is active when a sandbox collects it, OR when the session carries a
  // host-level ETW config. `View Sandbox` stays sandbox-only.
  const active = isSandbox ? (session?.sandbox?.collect_etw ?? false) : !!session?.etw;
  // The tracer can only produce new events while the session run is alive
  // (including Provisioning — the tracer starts before the debuggee); once
  // Stopped, the hook drains the tail and stops its poll interval.
  const live = canStopSession(session?.status);
  return (
    <EtwEventsView
      sessionId={session?.id}
      isSandbox={isSandbox}
      active={active}
      processId={processId}
      live={live}
    />
  );
}
