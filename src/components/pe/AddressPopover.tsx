import React, { useState, useRef, useCallback, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import { Copy, ArrowRight, Cpu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { copyToClipboard } from "@/lib/clipboard";
import { usePopoverDismiss } from "@/hooks/usePopoverDismiss";
import { AddrTriple, AddrMode, ADDR_MODE_LABELS, formatAddr } from "@/lib/peAddress";

interface PeAddressLinkProps {
  triple: AddrTriple;
  mode: AddrMode;
  /** True when the address points at code — a click opens the disassembly view;
   *  otherwise it opens the hex view. */
  isCode?: boolean;
  /** Jump to this address in the hex view (receives the file offset). */
  onGoToHex: (offset: number) => void;
  /** Jump to this address in the disassembly view (receives the VA). */
  onGoToDisasm: (va: bigint) => void;
  className?: string;
}

const rows = (t: AddrTriple): { label: string; text: string }[] =>
  (["va", "rva", "file"] as AddrMode[]).map((m) => ({ label: ADDR_MODE_LABELS[m], text: formatAddr(t, m) }));

// Grace delay so moving the pointer from the trigger into the popover (or briefly
// off an edge) doesn't dismiss it.
const CLOSE_DELAY_MS = 120;

/**
 * A clickable address. Hovering opens a popover showing VA / RVA / file-offset
 * (each copyable) plus explicit "go to" actions; a single click navigates
 * directly — to the disassembly view for code, or the hex view for data.
 * Rendered into a portal and positioned next to the trigger.
 */
export const PeAddressLink: React.FC<PeAddressLinkProps> = ({ triple, mode, isCode, onGoToHex, onGoToDisasm, className }) => {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const triggerRef = useRef<HTMLSpanElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useLayoutEffect(() => {
    if (open && triggerRef.current) {
      const r = triggerRef.current.getBoundingClientRect();
      setPos({ x: r.left, y: r.bottom + 4 });
    }
  }, [open]);

  const cancelClose = useCallback(() => {
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; }
  }, []);
  const openNow = useCallback(() => { cancelClose(); setOpen(true); }, [cancelClose]);
  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimer.current = setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  }, [cancelClose]);
  const close = useCallback(() => { cancelClose(); setOpen(false); }, [cancelClose]);
  usePopoverDismiss(open, close, triggerRef, popRef);

  // Direct navigation: code → disassembly (by VA), data → hex (by file offset).
  const navigate = useCallback(() => {
    close();
    if (isCode) onGoToDisasm(triple.va);
    else onGoToHex(triple.file);
  }, [close, isCode, onGoToDisasm, onGoToHex, triple.va, triple.file]);

  return (
    <>
      <span
        ref={triggerRef}
        className="inline-flex"
        onMouseEnter={openNow}
        onMouseLeave={scheduleClose}
      >
        <Button
          variant="link"
          onClick={navigate}
          className={`h-auto p-0 font-mono text-blue-500 hover:text-blue-400 ${className ?? ""}`}
        >
          {formatAddr(triple, mode)}
        </Button>
      </span>
      {open && createPortal(
        <div
          ref={popRef}
          className="fixed z-50 rounded-md border bg-popover text-popover-foreground shadow-md p-2 text-xs min-w-[220px]"
          style={{ left: pos.x, top: pos.y }}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
        >
          <div className="space-y-1">
            {rows(triple).map((r) => (
              <div key={r.label} className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">{r.label}</span>
                <span className="flex items-center gap-1">
                  <span className="font-mono select-text">{r.text}</span>
                  <Button size="icon-xs" variant="ghost" title={`Copy ${r.label}`} onClick={() => copyToClipboard(r.text, r.label)}>
                    <Copy className="h-3 w-3" />
                  </Button>
                </span>
              </div>
            ))}
          </div>
          <div className="mt-2 pt-2 border-t flex gap-1">
            <Button size="xs" variant="outline" onClick={() => { onGoToHex(triple.file); close(); }}>
              <ArrowRight className="h-3 w-3 mr-1" /> Hex
            </Button>
            <Button size="xs" variant="outline" onClick={() => { onGoToDisasm(triple.va); close(); }}>
              <Cpu className="h-3 w-3 mr-1" /> Disasm
            </Button>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
};
