import { useMatch, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { isProcessAvailable, sessionDisplayName } from "@/lib/sessionHelpers";
import { useSessionRoster, type SessionSummary } from "@/hooks/useSessionRoster";
import { useDisplayStatus } from "@/hooks/useDisplayStatus";
import type { SessionStatus } from "@/contexts/SessionContext";

/**
 * The live debug session, shown in the app header on every route — so you can
 * tell at a glance from Settings or Logs that a debuggee is sitting at a
 * breakpoint, and jump back to it in one click.
 *
 * Deliberately NOT tagged with `data-session-status`: that attribute is an e2e
 * contract (e2e/helpers/wait-helpers.ts calls toBeVisible() on
 * [data-session-status="Paused"], which throws under Playwright strict mode if
 * two nodes match), and the session view's own badge owns it. This uses
 * `data-active-session*` instead.
 */

/** Status word plus the dot color, from the semantic palette in App.css. */
function statusPresentation(status: SessionStatus): { label: string; dot: string } {
  if (typeof status !== "string") return { label: "Error", dot: "bg-destructive" };
  switch (status) {
    // amber — the palette's literal "execution state: paused"
    case "Paused":
      return { label: "Paused", dot: "bg-syn-state" };
    case "Running":
      return { label: "Running", dot: "bg-syn-flow animate-pulse" };
    case "Open":
      return { label: "Open", dot: "bg-muted-foreground" };
    default:
      return { label: status, dot: "bg-muted-foreground" };
  }
}

function StatusDot({ status, className }: { status: SessionStatus; className?: string }) {
  return (
    <span
      className={cn("size-2 rounded-full shrink-0", statusPresentation(status).dot, className)}
      aria-hidden
    />
  );
}

/** The pill body. Its own component so the debounce hook keys off one session. */
function SessionPill({
  session,
  extraCount,
}: {
  session: SessionSummary;
  extraCount: number;
}) {
  // Same anti-flicker rule as the session view: a burst of steps must not
  // strobe the header between Paused and Running.
  const displayStatus = useDisplayStatus(session.status);
  const { label } = statusPresentation(displayStatus);

  return (
    <>
      <StatusDot status={displayStatus} />
      <span className="truncate max-w-[16ch] font-medium">{sessionDisplayName(session)}</span>
      <span className="text-muted-foreground">·</span>
      <span className="text-muted-foreground">{label}</span>
      {extraCount > 0 && (
        <>
          <span className="text-muted-foreground">+{extraCount}</span>
          <ChevronDown className="size-3 text-muted-foreground" />
        </>
      )}
    </>
  );
}

export function ActiveSessionIndicator() {
  const navigate = useNavigate();
  const routeMatch = useMatch("/session/:sessionId");
  const roster = useSessionRoster();

  // "Live" = a process is actually there: Paused, Running, or a non-invasive
  // Open session. Stopped sessions are history, not status.
  const live = roster.filter((s) => isProcessAvailable(s.status));
  if (live.length === 0) return null;

  const routeId = routeMatch?.params.sessionId;
  const primary = live.find((s) => s.id === routeId) ?? live[0];
  const others = live.filter((s) => s.id !== primary.id);

  const pillClasses =
    "flex items-center gap-1.5 h-7 px-2 rounded-md text-xs max-w-[15rem] " +
    "border border-border bg-muted/40 hover:bg-accent hover:text-accent-foreground " +
    "transition-colors";

  if (others.length === 0) {
    return (
      <Button
        variant="ghost"
        size="xs"
        className={pillClasses}
        onClick={() => navigate(`/session/${primary.id}`)}
        data-active-session={primary.id}
        data-active-session-status={
          typeof primary.status === "string" ? primary.status : "Error"
        }
        title={`${sessionDisplayName(primary)} — go to session`}
      >
        <SessionPill key={primary.id} session={primary} extraCount={0} />
      </Button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="xs"
          className={pillClasses}
          data-active-session={primary.id}
          data-active-session-status={
            typeof primary.status === "string" ? primary.status : "Error"
          }
          aria-label="Active debug sessions"
          title="Active debug sessions"
        >
          <SessionPill key={primary.id} session={primary} extraCount={others.length} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        <DropdownMenuLabel>Active sessions</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {live.map((s) => (
          <DropdownMenuItem
            key={s.id}
            onSelect={() => navigate(`/session/${s.id}`)}
            className="gap-2"
          >
            <StatusDot status={s.status} />
            <span className="flex-1 truncate">{sessionDisplayName(s)}</span>
            <span className="text-xs text-muted-foreground">
              {statusPresentation(s.status).label}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
