import { StringsPanel } from "@/components/StringsPanel";
import { usePeStringScan, PeScanFn, PeStringHit } from "@/hooks/usePeStringScan";
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from "@/components/ui/select";
import { PeMapping, AddrMode, formatOffset, tripleFromOffset } from "@/lib/peAddress";

export type { PeStringHit };

interface PeStringsViewProps {
  scan: PeScanFn;
  fileName: string;
  mapping: PeMapping;
  mode: AddrMode;
  onGoToHex: (offset: number) => void;
  onGoToDisasm: (va: bigint) => void;
}

/**
 * Strings view for the PE viewer: the shared StringsPanel over an in-memory
 * whole-file scan. The scope selects mirror the session toolbar but a file has
 * exactly one scannable target, so each shows its single option. Rows are
 * addressed by file offset (formatted per the viewer's address mode) and jump
 * to the hex view.
 */
export const PeStringsView: React.FC<PeStringsViewProps> = ({ scan, fileName, mapping, mode, onGoToHex, onGoToDisasm }) => {
  const controller = usePeStringScan(scan);

  const scopeControls = (
    <>
      <Select value="module">
        <SelectTrigger size="xs" className="w-44 shrink-0">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="module" className="text-xs">Module</SelectItem>
        </SelectContent>
      </Select>
      <Select value="file">
        <SelectTrigger size="xs" className="flex-1 min-w-0">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="file" className="text-xs">
            <span className="font-mono">{fileName}</span>
          </SelectItem>
        </SelectContent>
      </Select>
    </>
  );

  return (
    <StringsPanel
      scan={controller}
      scopeControls={scopeControls}
      onScan={controller.handleScan}
      scanDisabled={controller.isScanning}
      columnWidthsKey="peStringsView"
      formatAddress={(address) => formatOffset(mapping, BigInt(address), mode)}
      onNavigateToMemory={(address) => onGoToHex(Number(address))}
      memoryNavLabel="Go to Hex View"
      onNavigateToDisassembly={(address) => onGoToDisasm(tripleFromOffset(mapping, Number(address)).va)}
    />
  );
};
