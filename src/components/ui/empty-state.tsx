import * as React from 'react';
import { Loader2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/** The icon box every non-results state uses. A panel swaps between these
 *  states (empty -> loading -> empty) without anything else on screen changing,
 *  so they must occupy the same box: a different icon size, or a missing
 *  subtitle line, makes the icon visibly jump or pulse in size on every swap. */
export const STATE_ICON_CLASS = 'h-12 w-12 mx-auto mb-4 opacity-50';

// Centered icon + title + subtitle, shared by every non-results panel state.
// `reserveSubtitle` keeps the subtitle's line when there is none, so a state
// without one sits exactly where a state with one does.
export function EmptyState({ icon, title, subtitle, danger, reserveSubtitle }: {
  icon: React.ReactNode; title: string; subtitle?: React.ReactNode; danger?: boolean; reserveSubtitle?: boolean;
}) {
  return (
    <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
      <div className="text-center">
        {icon}
        <p className="text-base font-medium">{title}</p>
        {subtitle != null
          ? <p className={`text-sm mt-1${danger ? ' text-destructive' : ''}`}>{subtitle}</p>
          : reserveSubtitle && <p className="text-sm mt-1 invisible" aria-hidden="true">&nbsp;</p>}
      </div>
    </div>
  );
}

/** Shared subtitle for every panel's "session exists but has no process" state
 *  (Stopped / exited), so the stopped UI reads the same everywhere. */
export const NO_PROCESS_HINT = 'No process — start, open, or attach to a target';

// The neutral "this panel needs a live process" state: `what` names the panel's
// data ("Disassembly", "Registers", …). Use when `sessionId && !canUseMemoryOps`;
// it is an ordinary UI state, never an error box or a toast. Takes the icon
// *component* so the sizing that makes every stopped panel look alike is here,
// not retyped at each call site.
export function ProcessUnavailableState({ icon: Icon, what }: { icon: LucideIcon; what: string }) {
  return (
    <EmptyState
      icon={<Icon className={STATE_ICON_CLASS} />}
      title={`${what} unavailable`}
      subtitle={NO_PROCESS_HINT}
    />
  );
}

// The "fetching, nothing to show yet" state. Same reason as
// `ProcessUnavailableState`: the sizing lives here so every loading panel looks
// alike, instead of being retyped at each call site — and so it fills the same
// box as the empty state it alternates with. By default a spinner; pass the
// panel's own `icon` to keep that icon in place and let it pulse instead.
export function LoadingState({ title, icon: Icon }: { title: string; icon?: LucideIcon }) {
  return (
    <EmptyState
      icon={Icon
        ? <Icon className={`${STATE_ICON_CLASS} animate-pulse`} />
        : <Loader2 className={`${STATE_ICON_CLASS} animate-spin`} />}
      title={title}
      reserveSubtitle
    />
  );
}
