import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { ScrollArea } from "./ui/scroll-area";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "./ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "./ui/select";
import { formatAddress, parseAddressExpression, RegisterContext, SymbolResolver } from "@/lib/hexUtils";
import { reportSessionError } from "@/lib/sessionHelpers";
import { plural } from "@/lib/utils";
import { usePlatform } from "@/contexts/PlatformContext";
import {
  PAGE_READWRITE, PAGE_SIZE, PROTECT_MODIFIERS, protectionsFor, splitProtect,
} from "@/lib/memoryProtect";

/** A range offered to the dialog: a region row, or nothing for manual entry. */
export interface ProtectTarget {
  /** Hex address ("0x..."). */
  address: string;
  size: number;
  /** Current protection, as the region list shows it. */
  protect: string;
  protectRaw: number;
}

interface ProtectResult {
  address: string;
  size: number;
  old_protect: number | null;
  error: string | null;
}

type SizeUnit = "bytes" | "pages";

/** Hex with `0x`, otherwise decimal; null when it is not a positive count. */
function parseCount(text: string): number | null {
  const t = text.trim();
  if (!/^(0x[0-9a-f]+|[0-9]+)$/i.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

interface MemoryProtectDialogProps {
  open: boolean;
  onClose: () => void;
  sessionId: string;
  /** Several: applied as listed. One: its address and size are prefilled and
   *  editable, so a region is narrowed to a few pages by editing two fields.
   *  None: a range typed by hand. */
  targets: ProtectTarget[];
  registers?: RegisterContext;
  resolveSymbol?: SymbolResolver;
  /** Called after every apply that reached the backend — protection changes
   *  split and merge regions, so the list behind the dialog must be re-read. */
  onApplied: () => void;
}

/**
 * Change the protection of memory pages: the selected regions, or one range
 * given as address + size. The address goes through the same expression grammar
 * as every address box (hex, registers, `module!symbol`, math).
 */
export function MemoryProtectDialog({
  open,
  onClose,
  sessionId,
  targets,
  registers,
  resolveSymbol,
  onApplied,
}: MemoryProtectDialogProps) {
  const os = usePlatform().os;
  const protections = useMemo(() => protectionsFor(os), [os]);
  const hasModifiers = os === "windows";

  const [address, setAddress] = useState("");
  const [size, setSize] = useState("");
  const [unit, setUnit] = useState<SizeUnit>("pages");
  const [base, setBase] = useState(PAGE_READWRITE);
  const [modifiers, setModifiers] = useState(0);
  const [busy, setBusy] = useState(false);
  const [failures, setFailures] = useState<ProtectResult[] | null>(null);

  const single = targets.length <= 1;

  // Each open starts from its targets: the range of the one region (or blank
  // for manual entry), and their protection when they all agree.
  useEffect(() => {
    if (!open) return;
    const only = targets.length === 1 ? targets[0] : null;
    setAddress(only?.address ?? "");
    setSize(only ? `0x${only.size.toString(16).toUpperCase()}` : "1");
    setUnit(only ? "bytes" : "pages");
    const agreed =
      targets.length > 0 && targets.every((t) => t.protectRaw === targets[0].protectRaw)
        ? splitProtect(targets[0].protectRaw)
        : { base: PAGE_READWRITE, modifiers: 0 };
    setBase(protections.some((p) => p.value === agreed.base) ? agreed.base : PAGE_READWRITE);
    setModifiers(hasModifiers ? agreed.modifiers : 0);
    setFailures(null);
    // Seeded on open only: the list behind refreshes while the dialog is up.
  }, [open]);

  const count = parseCount(size);
  const byteSize = count === null ? null : unit === "pages" ? count * PAGE_SIZE : count;
  const pages = byteSize === null ? null : Math.ceil(byteSize / PAGE_SIZE);
  const canApply = !busy && (single ? address.trim() !== "" && byteSize !== null : true);

  const apply = useCallback(async () => {
    setBusy(true);
    setFailures(null);
    try {
      let ranges: { address: string; size: number }[];
      if (single) {
        const resolved = await parseAddressExpression(address, registers ?? {}, resolveSymbol);
        if (resolved.address === null || byteSize === null) {
          toast.error(resolved.error || "The address could not be resolved");
          return;
        }
        ranges = [{ address: formatAddress(resolved.address), size: byteSize }];
      } else {
        ranges = targets.map((t) => ({ address: t.address, size: t.size }));
      }

      const results = await invoke<ProtectResult[]>("set_memory_protection", {
        sessionId,
        ranges,
        protect: base | modifiers,
      });
      onApplied();
      const failed = results.filter((r) => r.error);
      const changed = results.length - failed.length;
      if (failed.length === 0) {
        toast.success(`Changed the protection of ${plural(changed, "range")}`);
        onClose();
        return;
      }
      // Something was refused: stay open with the reasons next to the ranges.
      setFailures(failed);
      if (changed > 0) toast.warning(`Changed ${plural(changed, "range")}, ${failed.length} failed`);
    } catch (e) {
      reportSessionError("change memory protection", e, sessionId);
    } finally {
      setBusy(false);
    }
  }, [single, address, byteSize, registers, resolveSymbol, targets, sessionId, base, modifiers, onApplied, onClose]);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-xl" data-testid="memory-protect-dialog">
        <DialogHeader>
          <DialogTitle>Change memory protection</DialogTitle>
          <DialogDescription>
            {single
              ? "Protection applies to whole pages: the range is rounded out to page boundaries."
              : `The new protection is applied to all ${targets.length.toLocaleString()} selected regions.`}
          </DialogDescription>
        </DialogHeader>

        {single ? (
          <div className="grid grid-cols-[1fr_auto_auto] items-end gap-2">
            <div className="grid gap-1.5">
              <Label htmlFor="mem-protect-address">Address</Label>
              <Input
                id="mem-protect-address"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                className="font-mono"
                spellCheck={false}
                disabled={busy}
                placeholder="0x7FF6A0001000, rsp, module!symbol"
                data-testid="memory-protect-address"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="mem-protect-size">Size</Label>
              <Input
                id="mem-protect-size"
                value={size}
                onChange={(e) => setSize(e.target.value)}
                className="font-mono w-32"
                spellCheck={false}
                disabled={busy}
                aria-invalid={byteSize === null}
                data-testid="memory-protect-size"
              />
            </div>
            <Select value={unit} onValueChange={(v) => setUnit(v as SizeUnit)} disabled={busy}>
              <SelectTrigger className="w-24" data-testid="memory-protect-unit">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="pages">pages</SelectItem>
                <SelectItem value="bytes">bytes</SelectItem>
              </SelectContent>
            </Select>
            <span className="col-span-3 text-xs text-muted-foreground tabular-nums">
              {byteSize === null || pages === null
                ? "Size is a count: decimal, or hex with 0x."
                : `${plural(pages, "page")} (0x${(pages * PAGE_SIZE).toString(16).toUpperCase()} bytes)`}
            </span>
          </div>
        ) : (
          <ScrollArea className="max-h-40 rounded border">
            <ul className="text-xs font-mono p-2 space-y-0.5">
              {targets.map((t) => (
                <li key={t.address} className="flex gap-3" data-testid="memory-protect-target">
                  <span>{t.address}</span>
                  <span className="text-muted-foreground">+0x{t.size.toString(16).toUpperCase()}</span>
                  <span className="text-muted-foreground truncate">{t.protect}</span>
                </li>
              ))}
            </ul>
          </ScrollArea>
        )}

        <div className="grid gap-1.5">
          <Label>New protection</Label>
          <Select value={String(base)} onValueChange={(v) => setBase(Number(v))} disabled={busy}>
            <SelectTrigger className="w-full font-mono" data-testid="memory-protect-base">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {protections.map((p) => (
                <SelectItem key={p.value} value={String(p.value)} className="font-mono">
                  {p.name}
                  <span className="text-muted-foreground font-sans"> — {p.access}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {hasModifiers && (
            <div className="flex flex-wrap gap-x-4 gap-y-1.5 pt-1">
              {PROTECT_MODIFIERS.map((m) => (
                <div key={m.value} className="flex items-center gap-1.5" title={m.hint}>
                  <Checkbox
                    id={`mem-protect-mod-${m.value}`}
                    checked={(modifiers & m.value) !== 0}
                    onCheckedChange={(on) =>
                      setModifiers((prev) => (on === true ? prev | m.value : prev & ~m.value))
                    }
                    disabled={busy}
                    data-testid={`memory-protect-modifier-${m.name}`}
                  />
                  <Label htmlFor={`mem-protect-mod-${m.value}`} className="font-mono text-xs">
                    {m.name}
                  </Label>
                </div>
              ))}
            </div>
          )}
        </div>

        {failures && (
          <div className="rounded border border-destructive/40 bg-destructive/5 p-2">
            <div className="text-sm mb-1" data-testid="memory-protect-report">
              {plural(failures.length, "range")} not changed:
            </div>
            <ScrollArea className="max-h-32">
              <ul className="text-xs font-mono space-y-0.5 pr-2">
                {failures.map((f) => (
                  <li key={f.address} data-testid="memory-protect-failure">
                    {f.address} <span className="text-muted-foreground">— {f.error}</span>
                  </li>
                ))}
              </ul>
            </ScrollArea>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy} data-testid="memory-protect-cancel">
            {failures ? "Close" : "Cancel"}
          </Button>
          <Button onClick={apply} disabled={!canApply} data-testid="memory-protect-apply">
            {busy ? "Applying…" : "Change protection"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
