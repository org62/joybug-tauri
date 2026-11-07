import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Virtualizer } from "@tanstack/react-virtual";
import { AlertTriangle, ArrowRightToLine, Braces, Circle, RefreshCw } from "lucide-react";
import { VirtualizedList } from "./ui/virtualized-list";
import { DockPanel, PanelToolbar, PanelBody, PanelFooter } from "@/components/ui/panel";
import { ContextMenu, ContextMenuItem } from "@/components/ui/context-menu";
import { EmptyState, LoadingState, ProcessUnavailableState, STATE_ICON_CLASS } from "@/components/ui/empty-state";
import { Button } from "./ui/button";
import { Label } from "./ui/label";
import { Switch } from "./ui/switch";
import { CodeLineRow } from "./CodeLineRow";
import { cn, DATA_ROW_HEIGHT } from "@/lib/utils";
import { highlightToLines, type SyntaxLine } from "@/lib/syntaxHighlight";
import { pseudocodeNavigation } from "@/lib/navigationStore";
import { usePerfRender } from "@/lib/perf";
import { useContextMenu } from "@/hooks/useContextMenu";
import { useBreakpointLines, useLineFlash, useListingWidth } from "@/hooks/useCodeListing";
import { LOADING_STATE_DELAY_MS, useDelayedFlag } from "@/hooks/useDelayedFlag";
import { useRecenterOnReveal, applyOverFrames } from "@/hooks/useRecenterOnReveal";
import { usePseudocode, type DecompileFn } from "@/hooks/usePseudocode";

interface PseudocodeViewProps {
  /** Decompile the function at an address; null while the host has nothing open. */
  decompile: DecompileFn | null;
  pseudocodeScope: string;
  /** Session hosts: false when there is no process. File hosts leave it unset. */
  canLoad?: boolean;
  /** The instruction pointer while paused. Passing it (even as null) makes the
   *  host a live one: it gets "Follow PC". */
  pcAddress?: bigint | null;
  /** File hosts: the address to open on. */
  initialAddress?: bigint | null;
  inputsKeyFor?: (address: bigint) => string;
  /** Uppercase-hex breakpoint addresses, for gutter dots. */
  breakpointAddresses?: Set<string>;
  onToggleBreakpoint?: (address: string) => void;
  onNavigateToDisassembly?: (address: string) => void;
}

/**
 * Pseudocode of one function, line-synced with the disassembly: the line of
 * the instruction pointer is marked, a disassembly row click reveals its line
 * here, and a line leads back to its first instruction.
 */
export function PseudocodeView({
  decompile,
  pseudocodeScope,
  canLoad = true,
  pcAddress,
  initialAddress,
  inputsKeyFor,
  breakpointAddresses,
  onToggleBreakpoint,
  onNavigateToDisassembly,
}: PseudocodeViewProps) {
  usePerfRender("pseudocode");
  const { fn, status, error, isLoading, isBusy, pcLine, navLine, scrollTarget, followPc, toggleFollowPc, refresh } = usePseudocode({
    decompile,
    pseudocodeScope,
    canLoad,
    pcAddress,
    initialAddress,
    inputsKeyFor,
    navigation: pseudocodeNavigation,
  });

  const virtualizerRef = useRef<Virtualizer<HTMLDivElement, Element>>(null);
  const [selectedLine, setSelectedLine] = useState<number | null>(null);
  const { contextMenu, openContextMenu, closeContextMenu } = useContextMenu<{ line: number }>();

  const lines = fn?.lines;
  const lineCount = lines?.length ?? 0;
  const lineAddresses = fn?.lineAddresses;
  const highlighted = useMemo<SyntaxLine[] | null>(() => (lines ? highlightToLines(lines.join("\n"), "c") : null), [lines]);
  const numDigits = Math.max(3, String(lineCount).length);
  const minContentWidth = useListingWidth(lines, numDigits, 60);
  const breakpointLines = useBreakpointLines(lineAddresses, breakpointAddresses);
  // Announce only slow loads. That state replaces the list, so its reveal
  // observer must detach and attach when the actual viewport comes back.
  const slowLoad = useDelayedFlag(isLoading, LOADING_STATE_DELAY_MS);

  // A selection belongs to the text it was made in.
  useEffect(() => setSelectedLine(null), [lines]);

  // Center a line; bails while the tab is hidden (0-height viewport), and
  // useRecenterOnReveal applies it again when the tab is shown.
  const lineCountRef = useRef(lineCount);
  lineCountRef.current = lineCount;
  const centerLineRef = useRef<number | null>(null);
  const centerOn = useCallback((line: number) => {
    applyOverFrames(() => {
      const el = virtualizerRef.current?.scrollElement;
      if (!el || el.clientHeight === 0 || line > lineCountRef.current) return;
      el.scrollTop = Math.max(0, (line - 1) * DATA_ROW_HEIGHT - (el.clientHeight - DATA_ROW_HEIGHT) / 2);
    });
  }, []);
  const scrolledSeq = useRef(-1);
  useLayoutEffect(() => {
    // Not consumed until the rows it points into are mounted.
    if (!scrollTarget || scrollTarget.seq === scrolledSeq.current || !virtualizerRef.current?.scrollElement) return;
    scrolledSeq.current = scrollTarget.seq;
    centerLineRef.current = scrollTarget.line;
    centerOn(scrollTarget.line);
  }, [scrollTarget, lines, slowLoad, centerOn]);
  useRecenterOnReveal(virtualizerRef, lineCount > 0 && !slowLoad, centerLineRef, centerOn);

  // A navigation target flashes once, then stays tinted.
  const flashLine = useLineFlash(scrollTarget?.nav ? scrollTarget : null);

  // Row handlers are stable so the memoized rows skip unrelated renders.
  const goToDisassembly = useCallback(
    (line: number) => {
      const address = lineAddresses?.get(line)?.[0];
      if (address) onNavigateToDisassembly?.(address);
    },
    [lineAddresses, onNavigateToDisassembly],
  );
  const toggleBreakpoint = useCallback(
    (line: number) => {
      const address = lineAddresses?.get(line)?.[0];
      if (address) onToggleBreakpoint?.(address);
    },
    [lineAddresses, onToggleBreakpoint],
  );
  const openLineMenu = useCallback((e: React.MouseEvent, line: number) => openContextMenu(e, { line }), [openContextMenu]);

  // A host with a PC decompiles what a process has loaded.
  const live = pcAddress !== undefined;
  const menuLine = contextMenu?.data.line;
  const menuHasCode = menuLine !== undefined && lineAddresses?.has(menuLine);

  return (
    <DockPanel data-testid="pseudocode-panel">
      <PanelToolbar overflow="scroll">
        <div className="flex items-center gap-1 flex-1 min-w-28">
          <Braces className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="text-xs font-mono truncate select-text" title={fn?.name} data-testid="pseudocode-function">
            {fn ? fn.name : <span className="text-muted-foreground">No function</span>}
          </span>
        </div>

        <Button
          variant="outline"
          size="icon-xs"
          onClick={refresh}
          disabled={!decompile || !canLoad || isBusy}
          title="Decompile again"
          aria-label="Decompile again"
        >
          <RefreshCw className={cn(isBusy && "animate-spin")} />
        </Button>

        {fn?.differsFromImage && (
          <span
            className="flex items-center gap-1 text-xs text-syn-state whitespace-nowrap shrink-0"
            title="This function's code in memory differs from the module's file (a patch or a hook). The pseudocode is made from the file."
            data-testid="pseudocode-memory-differs"
          >
            <AlertTriangle className="h-3.5 w-3.5" />
            Memory differs
          </span>
        )}

        {live && (
          <div className="flex items-center gap-2 shrink-0 ml-2">
            <Label htmlFor="pseudocode-follow-pc" className="text-xs whitespace-nowrap">Follow PC</Label>
            <Switch id="pseudocode-follow-pc" size="xs" checked={followPc} onCheckedChange={toggleFollowPc} />
          </div>
        )}
      </PanelToolbar>

      {fn && !slowLoad ? (
        // --src-ln-w: the line-number column width, defined once for all rows.
        <div className="flex-1 min-h-0" style={{ "--src-ln-w": `${numDigits}ch` } as React.CSSProperties}>
          <VirtualizedList
            items={fn.lines}
            rowHeight={DATA_ROW_HEIGHT}
            overscan={30}
            className="h-full"
            virtualizerRef={virtualizerRef}
            minContentWidth={minContentWidth}
            renderItem={(text, index) => {
              const line = index + 1;
              return (
                <CodeLineRow
                  testId="pseudocode-row"
                  line={line}
                  text={text}
                  tokens={highlighted?.[index]}
                  hasCode={fn.lineAddresses.has(line)}
                  isPC={pcLine === line}
                  isNavTarget={navLine === line}
                  isFlashing={flashLine === line}
                  isSelected={selectedLine === line}
                  hasBreakpoint={breakpointLines.has(line)}
                  onClick={setSelectedLine}
                  onDoubleClick={goToDisassembly}
                  onGutterClick={onToggleBreakpoint && toggleBreakpoint}
                  onContextMenu={openLineMenu}
                />
              );
            }}
          />
        </div>
      ) : (
        <PanelBody>
          {slowLoad ? (
            <LoadingState icon={Braces} title="Decompiling..." />
          ) : !canLoad ? (
            <ProcessUnavailableState icon={Braces} what="Pseudocode" />
          ) : status === "failed" ? (
            <EmptyState icon={<Braces className={STATE_ICON_CLASS} />} title="Decompilation failed" subtitle={error} />
          ) : status === "no_function" ? (
            <EmptyState
              icon={<Braces className={STATE_ICON_CLASS} />}
              title="No function at this address"
              subtitle="The address is not inside a function of a module on disk"
            />
          ) : (
            <EmptyState
              icon={<Braces className={STATE_ICON_CLASS} />}
              title="No pseudocode"
              subtitle={live ? "Pause the target, or click an instruction in the disassembly" : "Click an instruction in the disassembly"}
            />
          )}
        </PanelBody>
      )}

      {fn && !slowLoad && (
        <PanelFooter className="justify-between text-[11px] text-muted-foreground tabular-nums">
          {/* A module is rarely loaded at the base its file names, and the
              engine never sees the process: say so where it shows. */}
          <span className="truncate">
            {live
              ? "Decompiled by Kuna from the module's file — addresses in the text are the file's, not the process's"
              : "Decompiled by Kuna from the file on disk"}
          </span>
          <span className="shrink-0">{lineCount.toLocaleString()} lines</span>
        </PanelFooter>
      )}

      {contextMenu && menuLine !== undefined && menuHasCode && (onToggleBreakpoint || onNavigateToDisassembly) && (
        <ContextMenu x={contextMenu.x} y={contextMenu.y} onClose={closeContextMenu} className="min-w-[180px]">
          {onToggleBreakpoint && (
            <ContextMenuItem icon={<Circle className="text-destructive" />} onClick={() => toggleBreakpoint(menuLine)}>
              Toggle Breakpoint
            </ContextMenuItem>
          )}
          {onNavigateToDisassembly && (
            <ContextMenuItem icon={<ArrowRightToLine className="text-syn-link" />} onClick={() => goToDisassembly(menuLine)}>
              Go to Disassembly
            </ContextMenuItem>
          )}
        </ContextMenu>
      )}
    </DockPanel>
  );
}
