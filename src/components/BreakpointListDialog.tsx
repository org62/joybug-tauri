import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Switch } from "./ui/switch";
import { Textarea } from "./ui/textarea";
import { ScrollArea } from "./ui/scroll-area";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "./ui/dialog";
import { parseAddressExpression, RegisterContext, SymbolResolver } from "@/lib/hexUtils";
import { numberedEntryLines, type ListEntry } from "@/lib/inputLists";
import { toast } from "sonner";

/** A line that produced no address, with the reason to show the user. */
type RejectedLine = ListEntry & { reason: string };

interface ApplyReport {
  /** "Set N breakpoints" — the same words the toast used. */
  summary: string;
  /** Entries dropped because an earlier line resolved to the same address. */
  duplicates: number;
  rejected: RejectedLine[];
}

const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;

/** Symbol lookups go to the backend one search at a time, so a long list is
 *  resolved a few lines at once rather than all at once (a thousand-line paste
 *  would otherwise open a thousand concurrent requests) or strictly serially. */
const RESOLVE_CONCURRENCY = 8;

/**
 * Resolve every entry through the same expression grammar the single-address
 * box uses, keeping input order. A line that doesn't resolve is collected
 * rather than aborting the batch — the whole point of pasting a list is that
 * one bad line shouldn't cost you the other ninety-nine.
 */
async function resolveEntries(
  entries: ListEntry[],
  registers: RegisterContext,
  resolveSymbol?: SymbolResolver,
): Promise<{ addresses: string[]; duplicates: number; rejected: RejectedLine[] }> {
  // Each distinct text is resolved once: a pasted list often repeats a name,
  // and every symbol line is a backend search.
  const unique = [...new Set(entries.map((e) => e.text))];
  const results = new Map<string, { address: string } | { reason: string }>();
  let next = 0;
  const worker = async () => {
    for (;;) {
      const text = unique[next++];
      if (text === undefined) return;
      try {
        const result = await parseAddressExpression(text, registers, resolveSymbol);
        results.set(
          text,
          result.address === null
            ? { reason: result.error || "could not be resolved" }
            : { address: `0x${result.address.toString(16)}` },
        );
      } catch (e) {
        results.set(text, { reason: e instanceof Error ? e.message : String(e) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(RESOLVE_CONCURRENCY, unique.length) }, worker));

  // Walk the lines in input order. The same address twice is not an error, but
  // sending it twice would make the applied count a lie.
  const seen = new Set<string>();
  const addresses: string[] = [];
  const rejected: RejectedLine[] = [];
  let duplicates = 0;
  for (const entry of entries) {
    const result = results.get(entry.text)!;
    if ("reason" in result) rejected.push({ ...entry, reason: result.reason });
    else if (seen.has(result.address)) duplicates++;
    else {
      seen.add(result.address);
      addresses.push(result.address);
    }
  }
  return { addresses, duplicates, rejected };
}

interface BreakpointListDialogProps {
  open: boolean;
  onClose: () => void;
  onApply: (addresses: string[], group?: string, singleShot?: boolean) => Promise<boolean>;
  registers?: RegisterContext;
  resolveSymbol?: SymbolResolver;
}

/**
 * Set many breakpoints from a pasted list. Each line goes through the same
 * expression grammar as the toolbar's single-address box (hex, decimal,
 * registers, `module!symbol`, and math like `rax+0x10`), so a list can mix
 * addresses and symbol names.
 *
 * Lines that don't resolve are skipped and reported by line number; the ones
 * that do are applied. Owns its own draft so typing never re-renders the
 * breakpoint list behind it.
 */
export function BreakpointListDialog({
  open,
  onClose,
  onApply,
  registers,
  resolveSymbol,
}: BreakpointListDialogProps) {
  const [draft, setDraft] = useState("");
  const [group, setGroup] = useState("");
  const [singleShot, setSingleShot] = useState(false);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<ApplyReport | null>(null);

  // Each open starts clean — a stale report from the previous run next to a
  // fresh list would read as this list's result.
  useEffect(() => {
    if (open) {
      setDraft("");
      setGroup("");
      setSingleShot(false);
      setReport(null);
    }
  }, [open]);

  const entries = useMemo(() => numberedEntryLines(draft), [draft]);

  const apply = useCallback(async () => {
    if (entries.length === 0) return;
    setBusy(true);
    setReport(null);
    try {
      const { addresses, duplicates, rejected } = await resolveEntries(
        entries,
        registers ?? {},
        resolveSymbol,
      );
      if (addresses.length > 0) {
        await onApply(addresses, group.trim() || undefined, singleShot);
      }
      const summary = `Set ${plural(addresses.length, "breakpoint")}`;
      if (rejected.length === 0) {
        toast.success(summary);
        onClose();
        return;
      }
      // Something was skipped: stay open with the reasons, so the user can fix
      // those lines instead of hunting for what a toast said a moment ago.
      setReport({ summary, duplicates, rejected });
      toast.warning(`${summary}, skipped ${plural(rejected.length, "line")}`);
    } finally {
      setBusy(false);
    }
  }, [entries, registers, resolveSymbol, group, singleShot, onApply, onClose]);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl" data-testid="breakpoint-list-dialog">
        <DialogHeader>
          <DialogTitle>Add breakpoints from a list</DialogTitle>
          <DialogDescription>
            One per line — an address like <span className="font-mono">0x140001000</span>, a
            symbol like <span className="font-mono">ntdll!NtClose</span>, or an expression like{" "}
            <span className="font-mono">rip+0x20</span>. Blank lines and lines starting with{" "}
            <span className="font-mono">#</span> or <span className="font-mono">;</span> are
            ignored. Lines that don't resolve are skipped and listed.
          </DialogDescription>
        </DialogHeader>

        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="font-mono h-56 resize-none"
          spellCheck={false}
          disabled={busy}
          data-testid="breakpoint-list-input"
          placeholder={"0x140001520\nntdll!NtClose\n# comments are ignored"}
        />

        <div className="flex items-center gap-3">
          <Input
            value={group}
            onChange={(e) => setGroup(e.target.value)}
            placeholder="Group (optional)"
            className="flex-1"
            disabled={busy}
            data-testid="breakpoint-list-group"
          />
          <div className="flex items-center gap-2">
            <Switch
              id="bp-list-single-shot"
              checked={singleShot}
              onCheckedChange={setSingleShot}
              disabled={busy}
              data-testid="breakpoint-list-single-shot"
            />
            <Label htmlFor="bp-list-single-shot" className="whitespace-nowrap">Single-shot</Label>
          </div>
        </div>

        {report && (
          <div className="rounded border border-destructive/40 bg-destructive/5 p-2">
            <div className="text-sm mb-1" data-testid="breakpoint-list-report">
              {report.summary}
              {report.duplicates > 0 && `, ${plural(report.duplicates, "duplicate line")} collapsed`}
              , skipped {report.rejected.length.toLocaleString()}:
            </div>
            <ScrollArea className="max-h-32">
              <ul className="text-xs font-mono space-y-0.5 pr-2">
                {report.rejected.map((r) => (
                  <li key={r.line} data-testid="breakpoint-list-rejected">
                    <span className="text-muted-foreground">line {r.line}:</span> {r.text}{" "}
                    <span className="text-muted-foreground">— {r.reason}</span>
                  </li>
                ))}
              </ul>
            </ScrollArea>
          </div>
        )}

        <DialogFooter className="sm:justify-between">
          <span className="text-xs text-muted-foreground tabular-nums self-center">
            {entries.length.toLocaleString()} {entries.length === 1 ? "entry" : "entries"}
          </span>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose} disabled={busy}>
              {report ? "Close" : "Cancel"}
            </Button>
            <Button
              onClick={apply}
              disabled={busy || entries.length === 0}
              data-testid="breakpoint-list-apply"
            >
              {busy ? "Resolving…" : "Add breakpoints"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
