import React, { useEffect, useState } from "react";
import { Crosshair } from "lucide-react";
import { DockPanel, PanelToolbar, PanelBody } from "@/components/ui/panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ContextMenu, ContextMenuItem } from "@/components/ui/context-menu";
import { VirtualizedList } from "@/components/ui/virtualized-list";
import { useContextMenu } from "@/hooks/useContextMenu";
import { PeMapping, AddrMode, formatVa } from "@/lib/peAddress";
import { LINK_VALUE_CLASS } from "@/lib/utils";
import { formatTauriError } from "@/lib/sessionHelpers";

/** One cross-reference as the backend reports it (`pe_xrefs_to`). */
export interface PeXref {
  from: string;
  kind: "call" | "jump" | "data" | "imm" | string;
  text: string;
  symbol: string | null;
}

export type PeXrefsFetchFn = (va: bigint) => Promise<PeXref[]>;

interface PeXrefsViewProps {
  /** Address whose references are listed; null until the user asks for one. */
  target: bigint | null;
  fetchXrefs: PeXrefsFetchFn;
  mapping: PeMapping;
  mode: AddrMode;
  onGoToDisasm: (va: bigint) => void;
  onGoToHex: (va: bigint) => void;
}

const KIND_LABEL: Record<string, string> = { call: "call", jump: "jmp", data: "data", imm: "imm" };
const ROW_HEIGHT = 24;

/**
 * Cross-references to one address of the opened PE: every call/jump whose
 * target it is (or whose IAT slot it is), every static memory operand and
 * every in-image immediate that names it. Rows jump to the referencing
 * instruction; the target itself is re-pickable from the disassembly context
 * menu and the structure tree's address popovers.
 */
export const PeXrefsView: React.FC<PeXrefsViewProps> = ({ target, fetchXrefs, mapping, mode, onGoToDisasm, onGoToHex }) => {
  const [xrefs, setXrefs] = useState<PeXref[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { contextMenu, openContextMenu, closeContextMenu } = useContextMenu<PeXref>();

  useEffect(() => {
    if (target === null) {
      setXrefs([]);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchXrefs(target)
      .then((rows) => { if (!cancelled) setXrefs(rows); })
      .catch((err) => { if (!cancelled) { setXrefs([]); setError(formatTauriError(err)); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [target, fetchXrefs]);

  // A status line (empty / loading / error / none) scrolls in a PanelBody; the
  // list itself is virtualized (a hot target can have thousands of callers),
  // so it owns its scroll region.
  const status =
    target === null ? (
      <EmptyState
        icon={<Crosshair className="h-12 w-12 mx-auto mb-4 opacity-50" />}
        title="No target selected"
        subtitle="Right-click an instruction → “Xrefs to this address”, or use an address popover in Structures"
      />
    ) : loading ? (
      <div className="px-3 py-2 text-xs text-muted-foreground">Scanning code sections…</div>
    ) : error ? (
      <div className="px-3 py-2 text-xs text-destructive">{error}</div>
    ) : xrefs.length === 0 ? (
      <div className="px-3 py-2 text-xs text-muted-foreground">No references found in the code sections.</div>
    ) : null;

  return (
    <DockPanel data-testid="pe-xrefs-panel">
      <PanelToolbar>
        <Crosshair className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs text-muted-foreground">Xrefs to</span>
        {target !== null ? (
          <Button
            variant="link"
            size="xs"
            className={`h-auto p-0 font-mono ${LINK_VALUE_CLASS}`}
            data-testid="pe-xrefs-target"
            onClick={() => onGoToDisasm(target)}
          >
            {formatVa(mapping, target, mode)}
          </Button>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
        {target !== null && !loading && (
          <span className="ml-auto text-xs text-muted-foreground" data-testid="pe-xrefs-count">{xrefs.length}</span>
        )}
      </PanelToolbar>
      {status ? (
        <PanelBody>{status}</PanelBody>
      ) : (
        <div className="flex-1 min-h-0 text-xs font-mono">
          <VirtualizedList
            items={xrefs}
            rowHeight={ROW_HEIGHT}
            className="h-full"
            getItemKey={(x) => `${x.from}-${x.kind}`}
            renderItem={(x) => (
              <div
                data-testid="pe-xref-row"
                className="flex items-center gap-2 px-2 h-6 hover:bg-muted/50 cursor-pointer"
                onClick={() => onGoToDisasm(BigInt(x.from))}
                onContextMenu={(e) => openContextMenu(e, x)}
              >
                <Badge variant="secondary" size="xs" className="w-10 justify-center shrink-0 px-1 py-0 leading-none font-mono">
                  {KIND_LABEL[x.kind] ?? x.kind}
                </Badge>
                <span className={`shrink-0 ${LINK_VALUE_CLASS}`}>{formatVa(mapping, BigInt(x.from), mode)}</span>
                {x.symbol && <span className="text-muted-foreground truncate shrink-0 max-w-[16rem]" title={x.symbol}>{x.symbol}</span>}
                <span className="truncate">{x.text}</span>
              </div>
            )}
          />
        </div>
      )}
      {contextMenu && (
        <ContextMenu x={contextMenu.x} y={contextMenu.y} onClose={closeContextMenu}>
          <ContextMenuItem onClick={() => onGoToDisasm(BigInt(contextMenu.data.from))}>Go to Disassembly</ContextMenuItem>
          <ContextMenuItem onClick={() => onGoToHex(BigInt(contextMenu.data.from))}>Go to Hex</ContextMenuItem>
        </ContextMenu>
      )}
    </DockPanel>
  );
};
