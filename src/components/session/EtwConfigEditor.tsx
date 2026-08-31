import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

/**
 * Rich per-operation ETW capture configurator. Edits the explicit op-token set
 * the tracer's `--capture` consumes (e.g. `file.create`, `registry.set_value`).
 * Grouped by kind with tri-state parent checkboxes, plus quick presets.
 */

interface OpItem {
  op: string;
  label: string;
}
interface OpGroup {
  kind: string;
  label: string;
  ops: OpItem[];
}

export const ETW_OP_GROUPS: OpGroup[] = [
  { kind: "process", label: "Process", ops: [
    { op: "process.start", label: "Start" },
    { op: "process.stop", label: "Stop" },
    { op: "process.thread_start", label: "Thread start" },
    { op: "process.thread_stop", label: "Thread stop" },
    { op: "process.image_load", label: "Image load (DLL)" },
    { op: "process.image_unload", label: "Image unload" },
  ] },
  { kind: "file", label: "File", ops: [
    { op: "file.create", label: "Create" },
    { op: "file.write", label: "Write" },
    { op: "file.delete", label: "Delete" },
    { op: "file.rename", label: "Rename" },
    { op: "file.open", label: "Open (read)" },
    { op: "file.read", label: "Read" },
    { op: "file.close", label: "Close" },
    { op: "file.dir_enum", label: "Directory enum" },
  ] },
  { kind: "registry", label: "Registry", ops: [
    { op: "registry.create_key", label: "Create key" },
    { op: "registry.set_value", label: "Set value" },
    { op: "registry.delete_key", label: "Delete key" },
    { op: "registry.delete_value", label: "Delete value" },
    { op: "registry.open_key", label: "Open key (read)" },
    { op: "registry.query", label: "Query value (read)" },
    { op: "registry.query_key", label: "Query key (read)" },
    { op: "registry.enum_key", label: "Enumerate keys (read)" },
    { op: "registry.enum_value", label: "Enumerate values (read)" },
  ] },
  { kind: "audit", label: "Sensitive APIs", ops: [
    { op: "audit.open_process", label: "OpenProcess (cross-process access)" },
    { op: "audit.open_thread", label: "OpenThread" },
  ] },
  { kind: "network", label: "Network", ops: [
    { op: "network.connect", label: "Connect" },
    { op: "network.accept", label: "Accept" },
    { op: "network.disconnect", label: "Disconnect" },
    { op: "network.send", label: "Send" },
    { op: "network.recv", label: "Receive" },
    { op: "network.retransmit", label: "Retransmit" },
    { op: "network.udp_send", label: "UDP send" },
    { op: "network.udp_recv", label: "UDP receive" },
  ] },
];

const ALL_OPS = ETW_OP_GROUPS.flatMap((g) => g.ops.map((o) => o.op));

/** All ops of one kind group, looked up by `kind` (never by array position). */
const groupOps = (kind: string): string[] =>
  ETW_OP_GROUPS.find((g) => g.kind === kind)?.ops.map((o) => o.op) ?? [];

/** The tracer's built-in default set (writes + process + network, no reads).
 * Wire-boundary mirror of `winsandbox::DEFAULT_OPS` — keep in sync. */
export const DEFAULT_OPS = [
  "process.start", "process.stop",
  "file.create", "file.write", "file.delete", "file.rename",
  "registry.create_key", "registry.set_value", "registry.delete_key", "registry.delete_value",
  "network.connect", "network.accept",
];

const WRITE_OPS = [
  "file.create", "file.write", "file.delete", "file.rename",
  "registry.create_key", "registry.set_value", "registry.delete_key", "registry.delete_value",
];

const ETW_PRESETS: { value: string; label: string; ops: string[] }[] = [
  { value: "all", label: "All activity (modifications)", ops: DEFAULT_OPS },
  { value: "all_reads", label: "All + reads", ops: [...DEFAULT_OPS, "file.open", "registry.open_key"] },
  { value: "modifications", label: "Modifications only", ops: WRITE_OPS },
  { value: "images", label: "Images & threads", ops: [
    "process.start", "process.stop",
    "process.thread_start", "process.thread_stop",
    "process.image_load", "process.image_unload",
  ] },
  { value: "files", label: "Files only", ops: groupOps("file") },
  { value: "registry", label: "Registry only", ops: groupOps("registry") },
  { value: "network", label: "Network only", ops: ["process.start", "process.stop", "network.connect", "network.accept"] },
  { value: "injection", label: "Injection & tampering", ops: [
    "process.start", "process.stop",
    "process.image_load",
    "audit.open_process", "audit.open_thread",
  ] },
  { value: "everything", label: "Everything", ops: ALL_OPS },
];

/** The op set for a coarse preset value (falls back to the default set). */
export function presetToOps(preset: string): string[] {
  const p = ETW_PRESETS.find((x) => x.value === preset);
  return p ? [...p.ops] : [...DEFAULT_OPS];
}

/** Map the current op set to a preset value, or "custom" when it matches none. */
function currentPreset(ops: string[]): string {
  const key = [...ops].sort().join(",");
  const found = ETW_PRESETS.find((p) => [...p.ops].sort().join(",") === key);
  return found ? found.value : "custom";
}

export function EtwConfigEditor({
  ops,
  onChange,
  callstacks,
  onCallstacksChange,
}: {
  ops: string[];
  onChange: (ops: string[]) => void;
  callstacks: boolean;
  onCallstacksChange: (v: boolean) => void;
}) {
  const set = new Set(ops);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const preset = currentPreset(ops);

  const applyPreset = (value: string) => {
    const p = ETW_PRESETS.find((x) => x.value === value);
    if (p) onChange(p.ops);
  };

  const toggleOp = (op: string) => {
    const next = new Set(set);
    if (next.has(op)) next.delete(op);
    else next.add(op);
    // Keep a stable catalog order.
    onChange(ALL_OPS.filter((o) => next.has(o)));
  };

  const toggleGroup = (group: OpGroup) => {
    const groupOps = group.ops.map((o) => o.op);
    const anyOn = groupOps.some((o) => set.has(o));
    const next = new Set(set);
    if (anyOn) groupOps.forEach((o) => next.delete(o));
    else groupOps.forEach((o) => next.add(o));
    onChange(ALL_OPS.filter((o) => next.has(o)));
  };

  const toggleExpand = (kind: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm">Events to capture</div>
        <Select value={preset} onValueChange={applyPreset}>
          <SelectTrigger size="xs" className="w-52">
            <SelectValue placeholder="Custom" />
          </SelectTrigger>
          <SelectContent>
            {ETW_PRESETS.map((p) => (
              <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
            ))}
            {preset === "custom" && <SelectItem value="custom" disabled>Custom</SelectItem>}
          </SelectContent>
        </Select>
      </div>

      <div className="rounded-md border divide-y">
        {ETW_OP_GROUPS.map((group) => {
          const groupOps = group.ops.map((o) => o.op);
          const onCount = groupOps.filter((o) => set.has(o)).length;
          const parentState: boolean | "indeterminate" =
            onCount === 0 ? false : onCount === groupOps.length ? true : "indeterminate";
          const isOpen = expanded.has(group.kind);
          return (
            <div key={group.kind}>
              <div className="flex items-center gap-2 px-2 py-1.5">
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className="size-5 text-muted-foreground"
                  onClick={() => toggleExpand(group.kind)}
                  aria-label={isOpen ? "Collapse" : "Expand"}
                >
                  <ChevronRight className={cn("size-3.5 transition-transform", isOpen && "rotate-90")} />
                </Button>
                <Checkbox checked={parentState} onCheckedChange={() => toggleGroup(group)} />
                <span className="text-sm select-none cursor-pointer" onClick={() => toggleGroup(group)}>
                  {group.label}
                </span>
                <span className="text-xs text-muted-foreground ml-auto tabular-nums">
                  {onCount}/{groupOps.length}
                </span>
              </div>
              {isOpen && (
                <div className="pb-1.5">
                  {group.ops.map((o) => (
                    <label
                      key={o.op}
                      className="flex items-center gap-2 pl-9 pr-2 py-0.5 text-sm cursor-pointer hover:bg-muted/40"
                    >
                      <Checkbox checked={set.has(o.op)} onCheckedChange={() => toggleOp(o.op)} />
                      <span className="select-none">{o.label}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm">Collect callstacks</div>
          <div className="text-xs text-muted-foreground">
            Capture the callstack of each event. Symbolized when a debugger is attached;
            raw addresses otherwise. Heavier.
          </div>
        </div>
        <Switch checked={callstacks} onCheckedChange={onCallstacksChange} />
      </div>
    </div>
  );
}
