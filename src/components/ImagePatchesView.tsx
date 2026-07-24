import { useMemo, useState } from "react";
import { FileDiff, Loader2, RefreshCw, Undo2 } from "lucide-react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { DockPanel, PanelToolbar, PanelBody } from "./ui/panel";
import { EmptyState } from "./ui/empty-state";
import { cn } from "@/lib/utils";
import { usePanelFocus } from "@/hooks/usePanelFocus";
import type { ImagePatch } from "@/hooks/useImagePatches";

interface ImagePatchesViewProps {
  patches: ImagePatch[];
  capped: boolean;
  scanning: boolean;
  scanned: boolean;
  /** True when a scan can run now (session paused). */
  canScan: boolean;
  onScan: () => void;
  onRestore?: (address: string) => void;
  onNavigateToDisassembly?: (address: string) => void;
}

/**
 * All in-memory code that differs from the on-disk images — what the
 * disassembly view's "Image Patches" toggle highlights, gathered across every
 * loaded module. Quick-filterable by address, symbol, or module substring.
 */
export function ImagePatchesView({
  patches,
  capped,
  scanning,
  scanned,
  canScan,
  onScan,
  onRestore,
  onNavigateToDisassembly,
}: ImagePatchesViewProps) {
  const filterRef = usePanelFocus<HTMLInputElement>("image_patches");
  const [filter, setFilter] = useState("");

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return patches;
    return patches.filter(
      (p) =>
        p.address.toLowerCase().includes(q) ||
        p.module.toLowerCase().includes(q) ||
        (p.symbol ?? "").toLowerCase().includes(q),
    );
  }, [patches, filter]);

  const emptyState = () => {
    if (scanning && patches.length === 0) {
      return <EmptyState icon={<Loader2 className="h-8 w-8 mx-auto mb-4 animate-spin" />} title="Scanning modules..." />;
    }
    const { title, subtitle } = !scanned
      ? { title: "Not scanned yet", subtitle: "Pause the session to scan loaded modules for image patches" }
      : patches.length === 0
        ? { title: "No image patches", subtitle: "In-memory code matches the on-disk module images" }
        : { title: "No matches", subtitle: "No image patch matches the current filter" };
    return (
      <EmptyState
        icon={<FileDiff className="h-12 w-12 mx-auto mb-4 opacity-50" />}
        title={title}
        subtitle={subtitle}
      />
    );
  };

  return (
    <DockPanel>
      <PanelToolbar>
        <Input
          ref={filterRef}
          inputSize="xs"
          className="flex-1 min-w-0"
          placeholder="Filter by address or symbol"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <Button
          variant="outline"
          size="icon-xs"
          onClick={onScan}
          disabled={!canScan || scanning}
          title={canScan ? "Rescan all modules" : "Pause the session to scan"}
        >
          <RefreshCw className={cn(scanning && "animate-spin")} />
        </Button>
        <span className="text-xs text-muted-foreground whitespace-nowrap">
          {filter.trim() ? `${filtered.length} / ${patches.length}` : patches.length}
          {capped && " (capped)"}
        </span>
      </PanelToolbar>
      <PanelBody>
        {filtered.length > 0 ? (
          filtered.map((p) => (
            <div
              key={p.address}
              className="px-2 py-1 border-b border-border/50 text-xs font-mono hover:bg-muted/30 group"
              data-testid="image-patch-row"
            >
              <div className="flex items-center gap-2 min-w-0">
                <span
                  className="text-blue-400 cursor-pointer hover:underline shrink-0"
                  onClick={() => onNavigateToDisassembly?.(p.address)}
                  title="Go to disassembly"
                >
                  {p.address}
                </span>
                <span className="text-muted-foreground truncate min-w-0" title={p.symbol ?? `${p.module}+${p.rva}`}>
                  {p.symbol ?? `${p.module}+${p.rva}`}
                </span>
                <span className="flex-1" />
                {p.tracked && (
                  <Badge variant="secondary" size="xs" title="Created by a patch in the User Patches window">
                    user
                  </Badge>
                )}
                {onRestore && (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="opacity-0 group-hover:opacity-100 transition-opacity"
                    disabled={!canScan}
                    onClick={() => onRestore(p.address)}
                    title="Restore original bytes"
                  >
                    <Undo2 />
                  </Button>
                )}
              </div>
              <div className="flex items-baseline gap-2 pl-4 text-muted-foreground min-w-0">
                <span className="shrink-0 select-none">-</span>
                <span className="w-44 shrink-0 truncate" title={p.original_bytes}>{p.original_bytes}</span>
                <span className="truncate min-w-0" title={p.original_disasm}>{p.original_disasm}</span>
              </div>
              <div className="flex items-baseline gap-2 pl-4 text-purple-500 min-w-0">
                <span className="shrink-0 select-none">+</span>
                <span className="w-44 shrink-0 truncate" title={p.current_bytes}>{p.current_bytes}</span>
                <span className="truncate min-w-0" title={p.current_disasm}>{p.current_disasm}</span>
              </div>
            </div>
          ))
        ) : (
          emptyState()
        )}
      </PanelBody>
    </DockPanel>
  );
}
