import * as React from 'react';
import { Loader2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

// Centered icon + title + subtitle, shared by every non-results panel state.
export function EmptyState({ icon, title, subtitle, danger }: {
  icon: React.ReactNode; title: string; subtitle?: React.ReactNode; danger?: boolean;
}) {
  return (
    <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
      <div className="text-center">
        {icon}
        <p className="text-base font-medium">{title}</p>
        {subtitle != null && <p className={`text-sm mt-1${danger ? ' text-destructive' : ''}`}>{subtitle}</p>}
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
      icon={<Icon className="h-12 w-12 mx-auto mb-4 opacity-50" />}
      title={`${what} unavailable`}
      subtitle={NO_PROCESS_HINT}
    />
  );
}

// The "fetching, nothing to show yet" state. Same reason as
// `ProcessUnavailableState`: the spinner sizing lives here so every loading
// panel looks alike, instead of being retyped at each call site.
export function LoadingState({ title }: { title: string }) {
  return <EmptyState icon={<Loader2 className="h-8 w-8 mx-auto mb-4 animate-spin" />} title={title} />;
}
