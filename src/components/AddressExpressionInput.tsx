import { ReactNode, useCallback } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  parseAddressExpression,
  sanitizeAddressInput,
  RegisterContext,
  SymbolResolver,
} from "@/lib/hexUtils";
import { toastError } from "@/lib/logger";
import { cn } from "@/lib/utils";
import { usePanelFocus } from "@/hooks/usePanelFocus";

interface AddressExpressionInputProps {
  value: string;
  onChange: (value: string) => void;
  /** Called with the resolved address after Enter or the Go button. */
  onResolve: (address: bigint) => void;
  registers?: RegisterContext;
  resolveSymbol?: SymbolResolver;
  /** Routes the invalid-expression toast to the session's log. */
  sessionId?: string;
  placeholder?: string;
  disabled?: boolean;
  /** Extra classes for the input (width sizing: `w-48`, `flex-1`, …). */
  inputClassName?: string;
  className?: string;
  /** Go-button content; defaults to "Go". */
  buttonLabel?: ReactNode;
  buttonTitle?: string;
  /** Dock tab id — "Go to" that tab focuses this input. Omit outside a dock tab. */
  focusTabId?: string;
}

/**
 * Address input shared by the disassembly, memory, breakpoints, and types
 * views. Accepts the full expression grammar of `parseAddressExpression`
 * (hex/decimal addresses, registers, `module!symbol`, and +/- math like
 * `rax+0x10`) and emits the resolved address on submit.
 */
export function AddressExpressionInput({
  value,
  onChange,
  onResolve,
  registers,
  resolveSymbol,
  sessionId,
  placeholder,
  disabled,
  inputClassName,
  className,
  buttonLabel = "Go",
  buttonTitle = "Go to address",
  focusTabId,
}: AddressExpressionInputProps) {
  const focusRef = usePanelFocus<HTMLInputElement>(focusTabId);
  // Advertise only what this input can actually resolve: register names need
  // a live register context, symbol names need a resolver (e.g. the PE viewer
  // has symbols but no registers).
  const hasRegisters = !!registers && Object.keys(registers).length > 0;
  const effectivePlaceholder =
    placeholder ??
    (hasRegisters
      ? "Address, symbol, rax+0x10..."
      : resolveSymbol
        ? "Address or symbol..."
        : "Address...");

  const submit = useCallback(async () => {
    const expression = value.trim();
    if (!expression) return;
    const result = await parseAddressExpression(expression, registers ?? {}, resolveSymbol);
    if (result.address === null) {
      toastError(result.error || "Invalid address expression", sessionId);
      return;
    }
    onResolve(result.address);
  }, [value, registers, resolveSymbol, sessionId, onResolve]);

  return (
    <div className={cn("flex items-center gap-1", className)}>
      <Input
        ref={focusRef}
        inputSize="xs"
        placeholder={effectivePlaceholder}
        value={value}
        disabled={disabled}
        className={cn("font-mono", inputClassName)}
        onChange={(e) => onChange(sanitizeAddressInput(e.target.value))}
        onKeyDown={(e) => e.key === "Enter" && submit()}
      />
      <Button variant="outline" size="xs" onClick={submit} disabled={disabled} title={buttonTitle}>
        {buttonLabel}
      </Button>
    </div>
  );
}
