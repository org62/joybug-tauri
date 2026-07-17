import { useCallback } from "react";
import { SymbolSearchView, SymbolSearchItem } from "@/components/SymbolSearchView";
import { PeMapping, AddrMode, formatAddr, tripleFromVa } from "@/lib/peAddress";

export type PeSymbol = SymbolSearchItem & { rva: number };

interface PeSymbolsViewProps {
  searchSymbols: (pattern: string, limit: number) => Promise<PeSymbol[]>;
  symbolsLoaded: boolean;
  symbolCount: number;
  mapping: PeMapping;
  mode: AddrMode;
  onGoToHex: (offset: number) => void;
  onGoToDisasm: (va: bigint) => void;
}

/**
 * Symbol Explorer for the PE viewer: the shared SymbolSearchView driven by the
 * file-backed search instead of the session context, with addresses rendered
 * per the viewer's VA/RVA/file-offset display mode.
 */
export const PeSymbolsView: React.FC<PeSymbolsViewProps> = ({ searchSymbols, symbolsLoaded, symbolCount, mapping, mode, onGoToHex, onGoToDisasm }) => {
  const navigate = useCallback((s: PeSymbol) => {
    const t = tripleFromVa(mapping, BigInt(s.va));
    if (s.is_function) onGoToDisasm(t.va);
    else onGoToHex(t.file);
  }, [mapping, onGoToHex, onGoToDisasm]);

  return (
    <SymbolSearchView<PeSymbol>
      searchSymbols={searchSymbols}
      enabled={symbolsLoaded}
      placeholder={symbolsLoaded ? "Search symbols…" : "Load symbols to search"}
      idleTitle={symbolsLoaded ? `${symbolCount.toLocaleString()} symbols are loaded` : "No symbols loaded"}
      idleSubtitle={symbolsLoaded ? undefined : "Load a PDB from the toolbar to search symbols"}
      formatAddress={(s) => formatAddr(tripleFromVa(mapping, BigInt(s.va)), mode)}
      onSelect={navigate}
    />
  );
};
