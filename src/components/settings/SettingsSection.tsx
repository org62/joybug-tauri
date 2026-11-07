import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * The building blocks every settings section is made of, so that sections of
 * any length read as one list down one column:
 *
 *   <SettingsSection title action>      a heading (+ an optional control on its right)
 *     <SettingsNote/>                   explanatory text
 *     <SettingsGroup>                   one bordered list of rows
 *       <SettingsRow label hint>control</SettingsRow>
 *
 * A row's control sits at the right edge; controls of a common kind share a
 * width (`SETTING_CONTROL_WIDTH`), which is what lines them up down the page.
 */

/** Width of a select / number / shortcut control in a settings row. */
export const SETTING_CONTROL_WIDTH = "w-[150px]";

export function SettingsSection({
  title,
  action,
  children,
  className,
  ...props
}: Omit<React.ComponentProps<"section">, "title"> & { title: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className={cn("space-y-2", className)} {...props}>
      <div className="flex items-center justify-between gap-3 min-h-7">
        <h3 className="text-base font-semibold">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

/** A heading inside a section, for a group of its own (a shortcut category). */
export function SettingsSubheading({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 min-h-7 pt-2">
      <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{children}</h4>
      {action}
    </div>
  );
}

export function SettingsGroup({ children }: { children: React.ReactNode }) {
  return <div className="rounded-lg border divide-y divide-border/60 overflow-hidden">{children}</div>;
}

export function SettingsRow({
  label,
  hint,
  nested,
  muted,
  children,
}: {
  label: React.ReactNode;
  /** A line of detail under the label. */
  hint?: React.ReactNode;
  /** A setting that belongs to the row above it. */
  nested?: boolean;
  /** The label of a setting that has no effect right now. */
  muted?: boolean;
  /** The control. */
  children?: React.ReactNode;
}) {
  return (
    <div className={cn("group flex items-center justify-between gap-4 min-h-10 py-1.5 pr-3 hover:bg-muted/40", nested ? "pl-8" : "pl-3")}>
      <div className="min-w-0">
        <div className={cn("text-sm", !nested && "font-medium", muted && "text-muted-foreground")}>{label}</div>
        {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
      </div>
      <div className="shrink-0 flex items-center gap-1">{children}</div>
    </div>
  );
}

export function SettingsNote({ className, ...props }: React.ComponentProps<"p">) {
  return <p className={cn("text-xs text-muted-foreground", className)} {...props} />;
}
