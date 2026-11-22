import { useId, useState, type FormEvent } from "react";
import type { ModuleBreakpointTarget } from "@/contexts/SessionContext";
import { formatTauriError } from "@/lib/sessionHelpers";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

interface ModuleBreakpointDialogProps {
  onClose: () => void;
  onAdd: (moduleName: string, target: ModuleBreakpointTarget) => Promise<void>;
}

export function ModuleBreakpointDialog({ onClose, onAdd }: ModuleBreakpointDialogProps) {
  const id = useId();
  const [moduleName, setModuleName] = useState("");
  const [kind, setKind] = useState<ModuleBreakpointTarget["kind"]>("symbol");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const targetLabel = kind === "symbol" ? "Symbol" : "Hex offset (RVA)";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    const module = moduleName.trim();
    const input = value.trim();
    if (!module || !input) {
      setError(!module ? "Enter a module filename or full target path." : `Enter a ${targetLabel.toLowerCase()}.`);
      return;
    }

    setError(null);
    setSubmitting(true);
    try {
      await onAdd(module, kind === "symbol" ? { kind, name: input } : { kind, hex: input });
      onClose();
    } catch (err) {
      setError(formatTauriError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !submitting) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add module breakpoint</DialogTitle>
          <DialogDescription>
            Use the module filename with extension or its full path in the target process.
            The breakpoint can bind when that module is loaded.
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={submit}>
          <div className="space-y-2">
            <Label htmlFor={`${id}-module`}>Module</Label>
            <Input
              id={`${id}-module`}
              value={moduleName}
              onChange={(event) => { setModuleName(event.target.value); setError(null); }}
              disabled={submitting}
            />
          </div>
          <div className="space-y-2">
            <Label id={`${id}-kind-label`} htmlFor={`${id}-kind`}>Target type</Label>
            <Select
              value={kind}
              onValueChange={(next) => {
                setKind(next === "rva" ? "rva" : "symbol");
                setValue("");
                setError(null);
              }}
              disabled={submitting}
            >
              <SelectTrigger id={`${id}-kind`} aria-labelledby={`${id}-kind-label`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="symbol">Symbol</SelectItem>
                <SelectItem value="rva">Hex offset (RVA)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${id}-value`}>{targetLabel}</Label>
            <Input
              id={`${id}-value`}
              placeholder={kind === "rva" ? "0x1234" : undefined}
              value={value}
              onChange={(event) => { setValue(event.target.value); setError(null); }}
              disabled={submitting}
            />
          </div>
          {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>Cancel</Button>
            <Button type="submit" disabled={submitting}>Add</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
