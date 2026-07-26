import { useState, useRef, useEffect, useLayoutEffect, useMemo, useCallback } from "react";
import type { UIEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { VirtualizedList } from "./ui/virtualized-list";
import { DockPanel, PanelToolbar, PanelBody, PanelFooter } from "@/components/ui/panel";
import { ContextMenu, ContextMenuItem } from "@/components/ui/context-menu";
import { Button } from "./ui/button";
import { Label } from "./ui/label";
import { Switch } from "./ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { FileCode, ChevronRight, Circle, RefreshCw, AlertTriangle, FolderSearch, ArrowRightToLine, CornerDownRight, ArrowDownToLine } from "lucide-react";
import { cn, DATA_ROW_HEIGHT, PC_ROW_HIGHLIGHT_CLASS } from "@/lib/utils";
import { useSourceView } from "@/hooks/useSourceView";
import { useContextMenu } from "@/hooks/useContextMenu";
import { Virtualizer } from "@tanstack/react-virtual";
import { languageForPath, highlightToLines, type SyntaxLine } from "@/lib/syntaxHighlight";

const SOURCE_ROW_HEIGHT = DATA_ROW_HEIGHT;

interface SourceLine {
  n: number;
  text: string;
}

interface SourceViewProps {
  sessionId?: string;
  isPaused?: boolean;
  address?: number;
  symbolsRefreshKey?: string;
  /** Uppercase-hex breakpoint addresses, for gutter dots. */
  breakpointAddresses?: Set<string>;
  onToggleBreakpoint?: (address: string) => void;
  onNavigateToDisassembly?: (address: string) => void;
}

function shortName(path: string): string {
  const idx = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return idx >= 0 ? path.slice(idx + 1) : path;
}

export function SourceView({
  sessionId,
  isPaused,
  address,
  symbolsRefreshKey,
  breakpointAddresses,
  onToggleBreakpoint,
  onNavigateToDisassembly,
}: SourceViewProps) {
  const {
    filePath,
    lineCount,
    windowStart,
    windowLines,
    lineMap,
    pcLine,
    navTargetLine,
    fileList,
    followPc,
    fileMissing,
    checksumMismatch,
    noLineInfo,
    isLoading,
    scrollToLine,
    selectFile,
    locateFile,
    toggleFollowPc,
    refresh,
    extendUp,
    extendDown,
    lineToAddress,
  } = useSourceView({ sessionId, isPaused, pcAddress: address, symbolsRefreshKey });

  const virtualizerRef = useRef<Virtualizer<HTMLDivElement, Element>>(null);
  const [selectedLine, setSelectedLine] = useState<number | null>(null);
  const [flashLine, setFlashLine] = useState<number | null>(null);
  const { contextMenu, openContextMenu, closeContextMenu } = useContextMenu<{ line: number; hasCode: boolean }>();

  // Rows carry ABSOLUTE line numbers (windowStart + offset), since only a window
  // of the file is loaded at a time.
  const items = useMemo<SourceLine[]>(
    () => windowLines.map((text, i) => ({ n: windowStart + i, text })),
    [windowLines, windowStart],
  );

  // Tokenize just the loaded window (bounded ≤ MAX_WINDOW, under the highlight
  // cap). Index i aligns with windowLines[i], i.e. absolute line windowStart + i.
  const highlighted = useMemo<SyntaxLine[] | null>(() => {
    if (windowLines.length === 0) return null;
    const lang = languageForPath(filePath);
    return highlightToLines(windowLines.join("\n"), lang);
  }, [windowLines, filePath]);

  // Widen the scroll area to the longest line so long lines scroll horizontally.
  const minContentWidth = useMemo(() => {
    let max = 80;
    for (const l of windowLines) if (l.length > max) max = l.length;
    return `${max + 12}ch`;
  }, [windowLines]);

  // Which source lines carry a breakpoint (any of the line's addresses is set).
  const breakpointLines = useMemo(() => {
    const set = new Set<number>();
    if (!breakpointAddresses || breakpointAddresses.size === 0) return set;
    for (const [line, addrs] of lineMap.entries()) {
      if (addrs.some((a) => breakpointAddresses.has(a.toUpperCase()))) set.add(line);
    }
    return set;
  }, [breakpointAddresses, lineMap]);

  // Extend the window when scrolling near a vertical edge (infinite scroll).
  const EDGE_EXTEND_PX = 400;
  const handleViewportScroll = useCallback(
    (e: UIEvent<HTMLDivElement>) => {
      const { scrollTop, scrollHeight, clientHeight } = e.currentTarget;
      if (scrollTop < EDGE_EXTEND_PX) extendUp();
      if (scrollHeight - scrollTop - clientHeight < EDGE_EXTEND_PX) extendDown();
    },
    [extendUp, extendDown],
  );

  // Current window bounds, mirrored for the ResizeObserver (no stale closure).
  const windowStartRef = useRef(windowStart);
  windowStartRef.current = windowStart;
  const windowLenRef = useRef(windowLines.length);
  windowLenRef.current = windowLines.length;
  // The line to keep centered — the PC/nav/goto target — for re-centering when
  // the panel becomes visible.
  const centerLineRef = useRef<number | null>(null);

  // Center `target` in the viewport. Sets scrollTop on the scroll element
  // directly (the most reliable path through Radix ScrollArea + the virtualizer)
  // and repeats across a couple of frames, since a freshly-replaced/newly-visible
  // window isn't measured yet on the first call.
  const centerOn = useCallback((target: number) => {
    const apply = () => {
      const el = virtualizerRef.current?.scrollElement;
      if (!el || el.clientHeight === 0) return false;
      const start = windowStartRef.current;
      const len = windowLenRef.current;
      if (target < start || target >= start + len) return false;
      el.scrollTop = Math.max(0, (target - start) * SOURCE_ROW_HEIGHT - (el.clientHeight - SOURCE_ROW_HEIGHT) / 2);
      return true;
    };
    apply();
    requestAnimationFrame(apply);
    setTimeout(apply, 40);
  }, []);

  // Keep the scroll position meaningful across window changes:
  // - goto/PC/nav (scrollToLine seq bump): scroll to the target line, repeating
  //   until the replace window lands and the target is actually in view
  // - window base moved (prepend / top-trim): anchor so content stays put
  const prevRef = useRef({ start: windowStart, seq: scrollToLine?.seq ?? -1 });
  const gotoLineRef = useRef<number | null>(null);
  useLayoutEffect(() => {
    const virtualizer = virtualizerRef.current;
    const viewport = virtualizer?.scrollElement;
    // Bail BEFORE consuming prevRef: while the window is still loading there's no
    // list mounted, and swallowing the scroll `seq` here would make the effect
    // anchor to the top (instead of centering) once the rows finally render.
    if (!virtualizer || !viewport) return;
    const prev = prevRef.current;
    const seq = scrollToLine?.seq ?? -1;
    const seqChanged = seq !== prev.seq;
    const startChanged = windowStart !== prev.start;
    prevRef.current = { start: windowStart, seq };

    if (seqChanged && scrollToLine) {
      gotoLineRef.current = scrollToLine.line;
      centerLineRef.current = scrollToLine.line;
    }

    if (gotoLineRef.current !== null) {
      const target = gotoLineRef.current;
      centerOn(target);
      // Finish once the target is actually inside the loaded window.
      if (target >= windowStart && target < windowStart + windowLines.length) gotoLineRef.current = null;
      return;
    }
    if (startChanged) {
      const delta = (prev.start - windowStart) * SOURCE_ROW_HEIGHT;
      virtualizer.scrollToOffset(Math.max(0, viewport.scrollTop + delta));
    }
  }, [windowStart, windowLines, scrollToLine, centerOn]);

  // rc-dock keeps hidden tabs mounted at zero height, so a PC move that happens
  // while the Source tab is hidden scrolls a 0-height viewport. Re-center on the
  // target line the moment the panel becomes visible (0 → positive height).
  const hasRows = items.length > 0;
  useEffect(() => {
    if (!hasRows) return;
    let ro: ResizeObserver | null = null;
    let raf = 0;
    const attach = () => {
      const el = virtualizerRef.current?.scrollElement;
      if (!el) {
        raf = requestAnimationFrame(attach);
        return;
      }
      let prevHeight = el.clientHeight;
      ro = new ResizeObserver(() => {
        const h = el.clientHeight;
        const becameVisible = prevHeight === 0 && h > 0;
        prevHeight = h;
        if (becameVisible && centerLineRef.current != null) {
          centerOn(centerLineRef.current);
        }
      });
      ro.observe(el);
    };
    attach();
    return () => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
    };
  }, [hasRows, centerOn]);

  // Transient highlight flash for nav-target lines.
  useEffect(() => {
    if (!scrollToLine?.transient) return;
    setFlashLine(scrollToLine.line);
    const timer = setTimeout(() => setFlashLine(null), 1000);
    return () => clearTimeout(timer);
  }, [scrollToLine]);

  const goToDisassembly = useCallback(
    (line: number) => {
      const addr = lineToAddress(line);
      if (addr && onNavigateToDisassembly) onNavigateToDisassembly(addr);
    },
    [lineToAddress, onNavigateToDisassembly],
  );

  const toggleBreakpoint = useCallback(
    (line: number) => {
      const addr = lineToAddress(line);
      if (addr && onToggleBreakpoint) onToggleBreakpoint(addr);
    },
    [lineToAddress, onToggleBreakpoint],
  );

  const showEmptyState = !sessionId || (filePath === null && !isLoading);

  const stepLine = useCallback(
    (dir: "over" | "into") => {
      if (!sessionId || !isPaused) return;
      const cmd = dir === "over" ? "step_over_line_debug_session" : "step_into_line_debug_session";
      invoke(cmd, { sessionId }).catch((e) => console.error(`step ${dir} line failed:`, e));
    },
    [sessionId, isPaused],
  );

  return (
    <DockPanel>
      <PanelToolbar>
        {/* Source file picker */}
        <div className="flex items-center gap-1 min-w-0">
          <FileCode className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          {fileList.length > 0 ? (
            <Select value={filePath ?? undefined} onValueChange={selectFile}>
              <SelectTrigger size="xs" className="w-56 font-mono">
                <SelectValue placeholder="Select source file">
                  {filePath ? shortName(filePath) : "Select source file"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {fileList.map((f) => (
                  <SelectItem key={f.path} value={f.path} className="font-mono text-xs">
                    {shortName(f.path)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <span className="text-xs font-mono text-muted-foreground truncate max-w-56" title={filePath ?? undefined}>
              {filePath ? shortName(filePath) : "No source"}
            </span>
          )}
        </div>

        {/* Source-line stepping */}
        <Button variant="outline" size="icon-xs" onClick={() => stepLine("over")} disabled={!isPaused} title="Step Over Line">
          <CornerDownRight />
        </Button>
        <Button variant="outline" size="icon-xs" onClick={() => stepLine("into")} disabled={!isPaused} title="Step Into Line">
          <ArrowDownToLine />
        </Button>

        {/* Refresh */}
        <Button variant="outline" size="icon-xs" onClick={refresh} disabled={isLoading} title="Re-resolve current line">
          <RefreshCw className={cn(isLoading && "animate-spin")} />
        </Button>

        {checksumMismatch && (
          <span className="flex items-center gap-1 text-xs text-syn-state" title="On-disk source differs from the build recorded in the PDB">
            <AlertTriangle className="h-3.5 w-3.5" />
            Source differs
          </span>
        )}

        {fileMissing && (
          <Button variant="outline" size="xs" onClick={locateFile} title="Locate this source file on disk">
            <FolderSearch className="h-3.5 w-3.5" />
            Locate...
          </Button>
        )}

        <div className="flex-1" />

        <div className="flex items-center gap-2">
          <Label htmlFor="follow-pc" className="text-xs">Follow PC</Label>
          <Switch id="follow-pc" size="xs" checked={followPc} onCheckedChange={toggleFollowPc} />
        </div>
      </PanelToolbar>

      {items.length > 0 ? (
        <div className="flex-1 min-h-0">
          <VirtualizedList
            items={items}
            rowHeight={SOURCE_ROW_HEIGHT}
            overscan={30}
            className="h-full"
            virtualizerRef={virtualizerRef}
            minContentWidth={minContentWidth}
            onViewportScroll={handleViewportScroll}
            getItemKey={(item) => item.n}
            renderItem={(item) => {
              const hasCode = lineMap.has(item.n);
              return (
                <SourceRow
                  line={item.n}
                  text={item.text}
                  tokens={highlighted?.[item.n - windowStart]}
                  hasCode={hasCode}
                  isPC={pcLine === item.n}
                  isNavTarget={navTargetLine === item.n}
                  isFlashing={flashLine === item.n}
                  isSelected={selectedLine === item.n}
                  hasBreakpoint={breakpointLines.has(item.n)}
                  onClick={() => setSelectedLine(item.n)}
                  onDoubleClick={() => goToDisassembly(item.n)}
                  onGutterClick={() => hasCode && toggleBreakpoint(item.n)}
                  onContextMenu={(e) => openContextMenu(e, { line: item.n, hasCode })}
                  style={{ height: SOURCE_ROW_HEIGHT }}
                />
              );
            }}
          />
        </div>
      ) : (
        <PanelBody>
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
            <div className="text-center">
              <FileCode className="h-12 w-12 mx-auto mb-4 opacity-50" />
              {showEmptyState ? (
                <>
                  <p className="text-base font-medium">No source available</p>
                  <p className="text-sm mt-1">Step or navigate to code with source line info</p>
                </>
              ) : fileMissing ? (
                <>
                  <p className="text-base font-medium">Source file not found</p>
                  <p className="text-sm mt-1 font-mono break-all max-w-md">{filePath}</p>
                  <Button variant="outline" size="sm" className="mt-3" onClick={locateFile}>
                    <FolderSearch className="h-4 w-4" />
                    Locate file...
                  </Button>
                </>
              ) : noLineInfo ? (
                <>
                  <p className="text-base font-medium">No source line for the current address</p>
                  <p className="text-sm mt-1">The instruction pointer isn't inside a known source line</p>
                </>
              ) : (
                <p className="text-base font-medium">Loading source...</p>
              )}
            </div>
          </div>
        </PanelBody>
      )}

      {filePath && !fileMissing && lineCount > 0 && (
        <PanelFooter className="justify-end text-[11px] text-muted-foreground tabular-nums">
          {lineCount.toLocaleString()} lines
        </PanelFooter>
      )}

      {contextMenu && (
        <ContextMenu x={contextMenu.x} y={contextMenu.y} onClose={closeContextMenu} className="min-w-[180px]">
          {onToggleBreakpoint && contextMenu.data.hasCode && (
            <ContextMenuItem
              icon={<Circle className="text-destructive" />}
              onClick={() => toggleBreakpoint(contextMenu.data.line)}
            >
              Toggle Breakpoint
            </ContextMenuItem>
          )}
          {onNavigateToDisassembly && contextMenu.data.hasCode && (
            <ContextMenuItem
              icon={<ArrowRightToLine className="text-syn-link" />}
              onClick={() => goToDisassembly(contextMenu.data.line)}
            >
              Go to Disassembly
            </ContextMenuItem>
          )}
        </ContextMenu>
      )}
    </DockPanel>
  );
}

interface SourceRowProps {
  line: number;
  text: string;
  tokens?: SyntaxLine;
  hasCode: boolean;
  isPC: boolean;
  isNavTarget: boolean;
  isFlashing: boolean;
  isSelected: boolean;
  hasBreakpoint: boolean;
  onClick: () => void;
  onDoubleClick: () => void;
  onGutterClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  style?: React.CSSProperties;
}

function SourceRow({
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
  style,
}: SourceRowProps) {
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
      style={style}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
    >
      {/* Breakpoint gutter (click to toggle when the line has code) */}
      <span
        className={cn("w-5 shrink-0 flex items-center justify-center", hasCode && "cursor-pointer")}
        onClick={(e) => { e.stopPropagation(); onGutterClick(); }}
        title={hasCode ? "Toggle breakpoint" : undefined}
      >
        {hasBreakpoint ? (
          <Circle className="h-2.5 w-2.5 fill-destructive text-destructive" />
        ) : hasCode ? (
          <Circle className="h-2 w-2 text-muted-foreground/30" />
        ) : null}
      </span>

      {/* PC indicator */}
      <span className="w-4 shrink-0 text-syn-state">
        {isPC && <ChevronRight className="h-3 w-3" />}
      </span>

      {/* Line number */}
      <span
        className={cn(
          "w-12 shrink-0 pr-2 text-right tabular-nums select-none",
          hasCode ? "text-muted-foreground" : "text-muted-foreground/40",
        )}
      >
        {line}
      </span>

      {/* Source text */}
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
}
