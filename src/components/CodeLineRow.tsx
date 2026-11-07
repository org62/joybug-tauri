import { memo } from "react";
import { ChevronRight, Circle } from "lucide-react";
import { cn, DATA_ROW_HEIGHT, PC_ROW_HIGHLIGHT_CLASS } from "@/lib/utils";
import type { SyntaxLine } from "@/lib/syntaxHighlight";

interface CodeLineRowProps {
  line: number;
  text: string;
  tokens?: SyntaxLine;
  /** The line maps to code: it can carry a breakpoint and be navigated from. */
  hasCode: boolean;
  isPC: boolean;
  isNavTarget: boolean;
  isFlashing: boolean;
  isSelected: boolean;
  hasBreakpoint: boolean;
  // Handlers take the line, so one stable function serves every row and the
  // memoized row skips renders that do not concern it.
  onClick: (line: number) => void;
  onDoubleClick: (line: number) => void;
  /** Unset where nothing can break (a file with no process): no gutter column. */
  onGutterClick?: (line: number) => void;
  onContextMenu: (e: React.MouseEvent, line: number) => void;
  /** Marks the row for tests. */
  testId?: string;
}

const ROW_STYLE = { height: DATA_ROW_HEIGHT };

/**
 * One line of code in a virtualized listing (source text, pseudocode):
 * breakpoint gutter, PC marker, line number, highlighted text.
 *
 * The line-number column takes its width from the `--src-ln-w` CSS variable,
 * which the list's container sets once for all rows.
 */
export const CodeLineRow = memo(function CodeLineRow({
  line,
  text,
  tokens,
  hasCode,
  isPC,
  isNavTarget,
  isFlashing,
  isSelected,
  hasBreakpoint,
  onClick,
  onDoubleClick,
  onGutterClick,
  onContextMenu,
  testId,
}: CodeLineRowProps) {
  return (
    <div
      className={cn(
        // overflow-hidden: rows are a fixed px height in a virtualized list, so
        // clip rather than let an over-tall line (e.g. under OS text scaling)
        // bleed into the neighbouring row. Prefer the UI-scale zoom for enlarging.
        "flex items-center overflow-hidden hover:bg-muted/30 cursor-default font-mono text-data",
        isSelected && "bg-accent/50",
        isPC && !isSelected && PC_ROW_HIGHLIGHT_CLASS,
        isNavTarget && !isPC && !isSelected && "bg-syn-link/10",
        isFlashing && "animate-highlight-fade",
      )}
      style={ROW_STYLE}
      onClick={() => onClick(line)}
      onDoubleClick={() => onDoubleClick(line)}
      onContextMenu={(e) => onContextMenu(e, line)}
      data-testid={testId}
      data-line={line}
      data-has-code={hasCode || undefined}
      data-pc={isPC || undefined}
      data-nav-target={isNavTarget || undefined}
      data-breakpoint={hasBreakpoint || undefined}
    >
      {/* Breakpoint gutter (click to toggle when the line has code) */}
      {onGutterClick && (
        <span
          className={cn("w-5 shrink-0 flex items-center justify-center", hasCode && "cursor-pointer")}
          onClick={(e) => { e.stopPropagation(); onGutterClick(line); }}
          title={hasCode ? "Toggle breakpoint" : undefined}
          data-testid={testId ? `${testId}-gutter` : undefined}
        >
          {hasBreakpoint ? (
            <Circle className="h-2.5 w-2.5 fill-destructive text-destructive" />
          ) : hasCode ? (
            <Circle className="h-2 w-2 text-muted-foreground/30" />
          ) : null}
        </span>
      )}

      {/* PC indicator */}
      <span className="w-4 shrink-0 text-syn-state">
        {isPC && <ChevronRight className="h-3 w-3" />}
      </span>

      {/* Line number (border-box width: --src-ln-w digits + the pr-2 gap) */}
      <span
        className={cn(
          "w-[calc(var(--src-ln-w)+0.5rem)] shrink-0 pr-2 text-right tabular-nums select-none",
          hasCode ? "text-muted-foreground" : "text-muted-foreground/40",
        )}
      >
        {line}
      </span>

      {/* Code text */}
      <span className="whitespace-pre text-foreground/90">
        {tokens && tokens.length > 0
          ? tokens.map((tok, i) =>
              tok.type ? (
                <span key={i} className={`tok-${tok.type}`}>{tok.text}</span>
              ) : (
                <span key={i}>{tok.text}</span>
              ),
            )
          : text || " "}
      </span>
    </div>
  );
});
