import { useState, useRef, useLayoutEffect, useMemo, useCallback } from "react";
import type { UIEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { VirtualizedList } from "./ui/virtualized-list";
import { DockPanel, PanelToolbar, PanelBody, PanelFooter } from "@/components/ui/panel";
import { ContextMenu, ContextMenuItem } from "@/components/ui/context-menu";
import { Button } from "./ui/button";
import { Label } from "./ui/label";
import { Switch } from "./ui/switch";
import { VirtualCombobox, type VirtualComboboxItem } from "./ui/virtual-combobox";
import { FileCode, Circle, RefreshCw, AlertTriangle, FolderSearch, ArrowRightToLine, CornerDownRight, ArrowDownToLine } from "lucide-react";
import { cn, DATA_ROW_HEIGHT } from "@/lib/utils";
import { CodeLineRow } from "./CodeLineRow";
import { moduleBasename, pathDirname } from "@/lib/symbolUtils";
import { useSourceView } from "@/hooks/useSourceView";
import { useContextMenu } from "@/hooks/useContextMenu";
import { useBreakpointLines, useLineFlash, useListingWidth } from "@/hooks/useCodeListing";
import { useRecenterOnReveal, applyOverFrames } from "@/hooks/useRecenterOnReveal";
import { Virtualizer } from "@tanstack/react-virtual";
import { languageForPath, highlightToLines, type SyntaxLine } from "@/lib/syntaxHighlight";
import { usePerfRender } from "@/lib/perf";

const SOURCE_ROW_HEIGHT = DATA_ROW_HEIGHT;

interface SourceLine {
  n: number;
  text: string;
}

interface SourceViewProps {
  sessionId?: string;
  isPaused?: boolean;
  /** False when the session has no process (Stopped). */
  canUseMemoryOps?: boolean;
  address?: number;
  symbolsRefreshKey?: string;
  /** Uppercase-hex breakpoint addresses, for gutter dots. */
  breakpointAddresses?: Set<string>;
  onToggleBreakpoint?: (address: string) => void;
  onNavigateToDisassembly?: (address: string) => void;
}

// Reused across sorts: a fresh localeCompare per comparison is an ICU call —
// thousands of file paths would cost tens of blocking ms.
const NAME_COLLATOR = new Intl.Collator(undefined, { sensitivity: "base" });

export function SourceView({
  sessionId,
  isPaused,
  canUseMemoryOps = true,
  address,
  symbolsRefreshKey,
  breakpointAddresses,
  onToggleBreakpoint,
  onNavigateToDisassembly,
}: SourceViewProps) {
  usePerfRender("source");
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
    lineInfoLoading,
    isLoading,
    scrollToLine,
    selectFile,
    locateFile,
    toggleFollowPc,
    refresh,
    extendUp,
    extendDown,
    lineToAddress,
  } = useSourceView({ sessionId, isPaused, canUseMemoryOps, pcAddress: address, symbolsRefreshKey });

  const virtualizerRef = useRef<Virtualizer<HTMLDivElement, Element>>(null);
  const [selectedLine, setSelectedLine] = useState<number | null>(null);
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

  // Digits needed by the line-number gutter. Sized to the file's last line
  // (the window is a slice of the file), so it stays stable while scrolling.
  const numDigits = Math.max(4, String(lineCount).length);

  const minContentWidth = useListingWidth(windowLines, numDigits, 80);

  // File-picker items, alphabetical by file name (paths can number in the
  // thousands for CRT-heavy PDBs — the picker virtualizes them).
  const fileItems = useMemo<VirtualComboboxItem[]>(
    () =>
      fileList
        .map((f) => ({ value: f.path, label: moduleBasename(f.path), detail: pathDirname(f.path) }))
        .sort((a, b) => NAME_COLLATOR.compare(a.label, b.label)),
    [fileList],
  );

  const breakpointLines = useBreakpointLines(lineMap, breakpointAddresses);

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
    applyOverFrames(apply);
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

  // A PC move that happens while the Source tab is hidden scrolls a 0-height
  // viewport — re-center on the target line once the panel is shown.
  useRecenterOnReveal(virtualizerRef, items.length > 0, centerLineRef, centerOn);

  // Transient highlight flash for nav-target lines.
  const flashLine = useLineFlash(scrollToLine?.transient ? scrollToLine : null);

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

  const openLineMenu = useCallback(
    (e: React.MouseEvent, line: number) => openContextMenu(e, { line, hasCode: lineMap.has(line) }),
    [openContextMenu, lineMap],
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
      <PanelToolbar overflow="scroll">
        {/* Source file picker. The wrapper shrinks (to its min width) before the
            toolbar starts scrolling horizontally; the trigger itself truncates. */}
        <div className="flex items-center gap-1 flex-1 min-w-28 max-w-56">
          <FileCode className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          {fileList.length > 0 ? (
            <VirtualCombobox
              items={fileItems}
              value={filePath}
              onValueChange={selectFile}
              placeholder="Select source file"
              searchPlaceholder="Filter files..."
              className="flex-1 min-w-0 font-mono"
              panelClassName="font-mono"
            />
          ) : (
            <span className="text-xs font-mono text-muted-foreground truncate" title={filePath ?? undefined}>
              {filePath ? moduleBasename(filePath) : "No source"}
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
        <Button variant="outline" size="icon-xs" onClick={refresh} disabled={isLoading || !canUseMemoryOps} title="Re-resolve current line">
          <RefreshCw className={cn(isLoading && "animate-spin")} />
        </Button>

        {checksumMismatch && (
          <span className="flex items-center gap-1 text-xs text-syn-state whitespace-nowrap shrink-0" title="On-disk source differs from the build recorded in the PDB">
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

        <div className="flex items-center gap-2 shrink-0">
          <Label htmlFor="follow-pc" className="text-xs whitespace-nowrap">Follow PC</Label>
          <Switch id="follow-pc" size="xs" checked={followPc} onCheckedChange={toggleFollowPc} />
        </div>
      </PanelToolbar>

      {items.length > 0 ? (
        // --src-ln-w: single definition of the line-number column width; rows
        // consume it via a static class instead of per-row style objects.
        <div className="flex-1 min-h-0" style={{ "--src-ln-w": `${numDigits}ch` } as React.CSSProperties}>
          <VirtualizedList
            items={items}
            rowHeight={SOURCE_ROW_HEIGHT}
            overscan={30}
            className="h-full"
            virtualizerRef={virtualizerRef}
            minContentWidth={minContentWidth}
            onViewportScroll={handleViewportScroll}
            getItemKey={(item) => item.n}
            renderItem={(item) => (
              <CodeLineRow
                line={item.n}
                text={item.text}
                tokens={highlighted?.[item.n - windowStart]}
                hasCode={lineMap.has(item.n)}
                isPC={pcLine === item.n}
                isNavTarget={navTargetLine === item.n}
                isFlashing={flashLine === item.n}
                isSelected={selectedLine === item.n}
                hasBreakpoint={breakpointLines.has(item.n)}
                onClick={setSelectedLine}
                onDoubleClick={goToDisassembly}
                onGutterClick={toggleBreakpoint}
                onContextMenu={openLineMenu}
              />
            )}
          />
        </div>
      ) : (
        <PanelBody>
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
            <div className="text-center">
              <FileCode className="h-12 w-12 mx-auto mb-4 opacity-50" />
              {sessionId && lineInfoLoading ? (
                // Before the empty state: there is no file to show *yet*.
                <>
                  <p className="text-base font-medium" data-testid="source-line-info-loading">Loading line information...</p>
                  <p className="text-sm mt-1">Reading the module's debug file; the source appears when it is done</p>
                </>
              ) : showEmptyState ? (
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
