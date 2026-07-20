import { useState, useEffect, useRef, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { HistoryInput } from "@/components/ui/history-input";
import { pushInputHistory } from "@/lib/inputHistory";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import {
  RegisterContext,
  SymbolResolver,
  parseAddressExpression,
} from "@/lib/hexUtils";

export interface SymbolResolveResult {
  address: bigint;
  displayName: string;
}

export type SymbolResolverWithName = (name: string) => Promise<SymbolResolveResult | null>;

interface RegisterEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  registerName: string;
  registerField: string;
  currentValue: string;
  onCommit: (field: string, hexValue: string) => void;
  registers: RegisterContext;
  resolveSymbolWithName: SymbolResolverWithName;
  /** Number of hex characters for the preview (16 for 64-bit, 8 for 32-bit). Defaults to 16. */
  hexWidth?: number;
}

export function RegisterEditDialog({
  open,
  onOpenChange,
  registerName,
  registerField,
  currentValue,
  onCommit,
  registers,
  resolveSymbolWithName,
  hexWidth = 16,
}: RegisterEditDialogProps) {
  const [input, setInput] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [resolvedLabel, setResolvedLabel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset state when dialog opens
  useEffect(() => {
    if (open) {
      const stripped = currentValue.replace(/^0x/i, "");
      setInput(stripped);
      setPreview(`0x${stripped.padStart(hexWidth, "0").toUpperCase()}`);
      setResolvedLabel(null);
      setError(null);
      setResolving(false);
    }
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [open, currentValue]);

  // Focus input when dialog opens
  useEffect(() => {
    if (open) {
      // Small delay to let the dialog render
      const t = setTimeout(() => inputRef.current?.select(), 50);
      return () => clearTimeout(t);
    }
  }, [open]);

  // Wrap the richer resolver into a standard SymbolResolver for parseAddressExpression,
  // capturing the matched symbol display name as a side effect
  const lastResolvedLabelRef = useRef<string | null>(null);

  const resolveSymbol: SymbolResolver = useCallback(async (name: string) => {
    const result = await resolveSymbolWithName(name);
    if (result) {
      lastResolvedLabelRef.current = result.displayName;
      return result.address;
    }
    lastResolvedLabelRef.current = null;
    return null;
  }, [resolveSymbolWithName]);

  const resolve = useCallback(
    (expr: string) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);

      const trimmed = expr.trim();
      if (!trimmed) {
        setPreview(null);
        setResolvedLabel(null);
        setError(null);
        setResolving(false);
        return;
      }

      // If it looks like a plain hex value, resolve immediately
      if (/^(0x)?[0-9a-fA-F]+$/.test(trimmed)) {
        const hex = trimmed.replace(/^0x/i, "");
        setPreview(`0x${hex.padStart(hexWidth, "0").toUpperCase()}`);
        setResolvedLabel(null);
        setError(null);
        setResolving(false);
        return;
      }

      setResolving(true);
      debounceRef.current = setTimeout(async () => {
        lastResolvedLabelRef.current = null;
        try {
          const result = await parseAddressExpression(
            trimmed,
            registers,
            resolveSymbol
          );
          if (result.address !== null) {
            const hex = result.address
              .toString(16)
              .padStart(hexWidth, "0")
              .toUpperCase();
            setPreview(`0x${hex}`);
            setResolvedLabel(lastResolvedLabelRef.current);
            setError(null);
          } else {
            setPreview(null);
            setResolvedLabel(null);
            setError(result.error ?? "Invalid expression");
          }
        } catch {
          setPreview(null);
          setResolvedLabel(null);
          setError("Failed to resolve expression");
        }
        setResolving(false);
      }, 300);
    },
    [registers, resolveSymbol]
  );

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = e.target.value;
      setInput(val);
      resolve(val);
    },
    [resolve]
  );

  const handleCommit = useCallback(() => {
    if (!preview) return;
    pushInputHistory("register-value", input);
    const hex = preview.replace(/^0x/i, "");
    onCommit(registerField, hex);
    onOpenChange(false);
  }, [preview, input, registerField, onCommit, onOpenChange]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleCommit();
      }
    },
    [handleCommit]
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="text-base">Edit {registerName}</DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            Enter a hex value, register name, symbol, or expression (e.g.
            rsp+0x10)
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          <HistoryInput
            historyKey="register-value"
            ref={inputRef}
            className="font-mono text-sm"
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder="0x0, rsp+0x10, ntdll!main..."
            spellCheck={false}
            autoComplete="off"
          />

          <div className="min-h-5 text-xs font-mono flex items-center gap-2">
            {resolving && (
              <span className="flex items-center gap-1 text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                Resolving...
              </span>
            )}
            {!resolving && error && (
              <span className="text-destructive">{error}</span>
            )}
            {!resolving && preview && !error && (
              <>
                <span className="text-green-500">{preview}</span>
                {resolvedLabel && (
                  <span className="text-muted-foreground">({resolvedLabel})</span>
                )}
              </>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleCommit}
            disabled={!preview || resolving}
          >
            Set
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
