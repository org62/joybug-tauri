import * as React from "react";
import { Copy } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { copyToClipboard } from "@/lib/clipboard";

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
          onClick={() => copyToClipboard(copyText ?? text, label)}
        >
          <Copy />
        </Button>
      </div>
    </TooltipContent>
  );
}

const ELLIPSIS = "…";

/**
 * Width of `str` if it were laid out in `font`. Canvas measurement touches no
 * DOM and forces no layout, so it is cheap enough to run per visible row.
 */
let measureCtx: CanvasRenderingContext2D | null | undefined;
function textWidth(str: string, font: string): number {
  measureCtx ??= document.createElement("canvas").getContext("2d");
  if (!measureCtx) return 0;
  measureCtx.font = font;
  return measureCtx.measureText(str).width;
}

/**
 * Canvas font string for an element, assembled from the longhands. The `font`
 * shorthand computes to "" unless every sub-property was authored together, and
 * canvas silently falls back to "10px sans-serif" on an unparseable value —
 * which measures far too narrow and would cut into the pinned tail.
 */
function fontOf(el: Element): string {
  const s = getComputedStyle(el);
  return `${s.fontStyle} ${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;
}

/** One ResizeObserver shared by every instance, rather than one each. */
const resizeCallbacks = new WeakMap<Element, () => void>();
let sharedResizeObserver: ResizeObserver | null = null;
function observeWidth(el: Element, onResize: () => void): () => void {
  if (typeof ResizeObserver === "undefined") return () => {};
  sharedResizeObserver ??= new ResizeObserver((entries) => {
    for (const entry of entries) resizeCallbacks.get(entry.target)?.();
  });
  resizeCallbacks.set(el, onResize);
  sharedResizeObserver.observe(el);
  return () => {
    resizeCallbacks.delete(el);
    sharedResizeObserver?.unobserve(el);
  };
}

interface MiddleTruncateProps extends React.HTMLAttributes<HTMLSpanElement> {
  text: string;
  /** Number of trailing characters that stay pinned (default 10). */
  tailChars?: number;
}

/**
 * Width-responsive middle-ellipsis: the head is cut and the last `tailChars`
 * characters stay pinned, giving "abc…tail" only once space runs out. Renders
 * seamlessly (no split, no ellipsis) whenever the text fits. Must live inside a
 * min-w-0 flex child, like a plain `truncate` span would.
 *
 * Two things make this awkward, and the structure here exists to answer both:
 *
 * 1. `text-overflow: ellipsis` can't be used. It draws the ellipsis where the
 *    last whole glyph ended and leaves the rest of the box blank — up to a full
 *    character of dead space between the "…" and the pinned tail, varying with
 *    the column width. So the cut is computed here and rendered as one string.
 *
 * 2. Measuring must not feed back into the measurement. A span sized by its own
 *    text would shrink to whatever was just cut, so the next pass would measure
 *    a smaller box and cut again, a character at a time. The ::before sizer below
 *    holds the *full* text and is what gives this span its width, so the budget
 *    is the layout's to decide and never moves in response to a cut.
 */
const MiddleTruncate = React.forwardRef<HTMLSpanElement, MiddleTruncateProps>(
  ({ text, tailChars = 10, className, ...props }, ref) => {
    const hostRef = React.useRef<HTMLSpanElement | null>(null);
    const setHost = React.useCallback(
      (node: HTMLSpanElement | null) => {
        hostRef.current = node;
        if (typeof ref === "function") ref(node);
        else if (ref) ref.current = node;
      },
      [ref],
    );

    // Characters of `text` kept before the ellipsis; null = fits, render as-is.
    const [headChars, setHeadChars] = React.useState<number | null>(null);
    const [revision, remeasure] = React.useReducer((n: number) => n + 1, 0);
    const measuredWidth = React.useRef(-1);

    React.useLayoutEffect(() => {
      const host = hostRef.current;
      if (!host) return;
      const budget = host.clientWidth;
      if (budget <= 0) return;
      measuredWidth.current = budget;

      const font = fontOf(host);
      if (textWidth(text, font) <= budget) {
        setHeadChars(null);
        return;
      }
      // Largest head that still leaves room for the ellipsis and the tail. The
      // upper bound keeps head and tail from overlapping on short strings.
      const pinned = ELLIPSIS + text.slice(-tailChars);
      const pinnedWidth = textWidth(pinned, font);
      let lo = 0;
      let hi = Math.max(0, text.length - tailChars);
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (textWidth(text.slice(0, mid), font) + pinnedWidth <= budget) lo = mid;
        else hi = mid - 1;
      }
      setHeadChars(lo);
    }, [text, tailChars, revision]);

    // Re-cut when the column is resized. Safe to observe our own box: the sizer
    // pins its width to the full text, so a cut can never trigger this.
    React.useEffect(() => {
      const host = hostRef.current;
      if (!host) return;
      return observeWidth(host, () => {
        if (host.clientWidth !== measuredWidth.current) remeasure();
      });
    }, []);

    // Metrics before the webfont lands are the fallback face's; re-cut once.
    React.useEffect(() => {
      if (typeof document === "undefined" || !document.fonts) return;
      if (document.fonts.status === "loaded") return;
      let alive = true;
      document.fonts.ready.then(() => { if (alive) remeasure(); });
      return () => { alive = false; };
    }, []);

    return (
      <span
        ref={setHost}
        // The sizer (note 2) is a ::before carrying the full text: it occupies
        // space and so fixes this span's width, but being a pseudo-element it
        // stays out of textContent, the selection and the a11y tree — unlike a
        // hidden sibling span, which would double every name in all three.
        data-full-text={text}
        className={cn(
          "relative inline-flex min-w-0 max-w-full overflow-hidden whitespace-pre",
          "before:invisible before:content-[attr(data-full-text)]",
          className,
        )}
        {...props}
      >
        <span className="absolute inset-0">
          {headChars === null
            ? text
            : text.slice(0, headChars) + ELLIPSIS + text.slice(-tailChars)}
        </span>
      </span>
    );
  },
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

export { MiddleTruncate, TruncatedSymbol, CopyTooltipContent };
