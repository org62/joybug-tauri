import * as React from "react";
import { Copy } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { toastError, toastSuccess } from "@/lib/logger";

/** Clipboard write with success/error toasts; `label` names what was copied. */
async function copyWithToast(text: string, label: string) {
  try {
    await navigator.clipboard.writeText(text);
    toastSuccess(`${label} copied`);
  } catch (e) {
    toastError(`Failed to copy: ${e}`);
  }
}

interface CopyTooltipContentProps {
  text: string;
  /** Text placed on the clipboard (defaults to `text`). */
  copyText?: string;
  /** Noun for the toast and button title, e.g. "Symbol" or "Chain". */
  label?: string;
  side?: React.ComponentProps<typeof TooltipContent>["side"];
}

/**
 * Tooltip body showing the full text with a copy button. Shared by
 * TruncatedSymbol and DereferenceDisplay so the copy UX stays uniform.
 */
function CopyTooltipContent({
  text,
  copyText,
  label = "Symbol",
  side = "bottom",
}: CopyTooltipContentProps) {
  return (
    <TooltipContent
      side={side}
      align="start"
      className="max-w-md font-mono text-xs select-text"
    >
      <div className="flex items-start gap-1.5">
        <span className="break-all">{text}</span>
        <Button
          variant="ghost"
          size="icon-xs"
          className="shrink-0"
          title={`Copy ${label.toLowerCase()}`}
          onClick={() => copyWithToast(copyText ?? text, label)}
        >
          <Copy />
        </Button>
      </div>
    </TooltipContent>
  );
}

interface MiddleTruncateProps extends React.HTMLAttributes<HTMLSpanElement> {
  text: string;
  /** Number of trailing characters that stay pinned (default 10). */
  tailChars?: number;
}

/**
 * Width-responsive middle-ellipsis: the head truncates ("abc…") while the
 * tail stays pinned, yielding "abc…tail" only when space runs out. Renders
 * seamlessly (no visible split) when the text fits. Must live inside a
 * min-w-0 flex child, like a plain `truncate` span would.
 */
const MiddleTruncate = React.forwardRef<HTMLSpanElement, MiddleTruncateProps>(
  ({ text, tailChars = 10, className, ...props }, ref) => {
    // Only split when the head is long enough to absorb the ellipsis; a
    // shrink-0 tail on short text would overflow instead of ellipsizing.
    const split = text.length > tailChars + 4;
    return (
      <span
        ref={ref}
        className={cn("inline-flex min-w-0 max-w-full", className)}
        {...props}
      >
        {split ? (
          <>
            <span className="truncate whitespace-pre">{text.slice(0, -tailChars)}</span>
            <span className="shrink-0 whitespace-pre">{text.slice(-tailChars)}</span>
          </>
        ) : (
          <span className="truncate">{text}</span>
        )}
      </span>
    );
  }
);
MiddleTruncate.displayName = "MiddleTruncate";

interface TruncatedSymbolProps
  extends Omit<React.HTMLAttributes<HTMLSpanElement>, "children"> {
  text: string;
  /** Text placed on the clipboard (defaults to `text`). */
  copyText?: string;
  tailChars?: number;
  side?: React.ComponentProps<typeof TooltipContent>["side"];
}

/**
 * Middle-ellipsized symbol with a hover tooltip showing the full text and a
 * copy button. Copying happens in the tooltip (portalled), so it never leaks
 * clicks into row handlers. Extra span props (e.g. onClick) are forwarded to
 * the visible symbol span. Relies on the app-root TooltipProvider for hover
 * delay, so per-row instances stay cheap in virtualized lists.
 */
function TruncatedSymbol({
  text,
  copyText,
  tailChars,
  className,
  side = "bottom",
  ...spanProps
}: TruncatedSymbolProps) {
  if (!text) {
    return null;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <MiddleTruncate text={text} tailChars={tailChars} className={className} {...spanProps} />
      </TooltipTrigger>
      <CopyTooltipContent text={text} copyText={copyText} side={side} />
    </Tooltip>
  );
}

export { MiddleTruncate, TruncatedSymbol, CopyTooltipContent, copyWithToast };
