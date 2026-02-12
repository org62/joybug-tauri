import { parseAddress } from "@/lib/hexUtils";

export interface SymbolSearchResult {
  va: string;
  name: string;
  display_name: string;
  module_name: string;
}

export type SearchSymbolsFn = (pattern: string, limit: number) => Promise<SymbolSearchResult[]>;

export interface ResolvedSymbol {
  address: bigint;
  displayName: string;
}

/**
 * Resolves a symbol name (with optional "module!symbol" syntax) to an address.
 * Returns the best match along with its display name, or null if not found.
 */
export async function resolveSymbol(
  searchSymbols: SearchSymbolsFn,
  name: string,
): Promise<ResolvedSymbol | null> {
  let searchPattern = name;
  let moduleFilter: string | null = null;

  const bangIndex = name.indexOf("!");
  if (bangIndex !== -1) {
    moduleFilter = name.substring(0, bangIndex).toLowerCase();
    searchPattern = name.substring(bangIndex + 1);
  }

  const symbols = await searchSymbols(searchPattern, 50);

  let candidates = symbols;

  if (moduleFilter) {
    candidates = symbols.filter((s) => {
      const moduleName = s.module_name.toLowerCase();
      return (
        moduleName === moduleFilter ||
        moduleName.startsWith(moduleFilter + ".") ||
        moduleName.replace(/\.(exe|dll|sys)$/i, "") === moduleFilter
      );
    });
  }

  const makeResult = (s: SymbolSearchResult): ResolvedSymbol | null => {
    const address = parseAddress(s.va);
    return address !== null ? { address, displayName: s.display_name } : null;
  };

  // Exact symbol name match (case-insensitive)
  const exactMatch = candidates.find(
    (s) => s.name.toLowerCase() === searchPattern.toLowerCase(),
  );
  if (exactMatch) return makeResult(exactMatch);

  // First candidate
  if (candidates.length > 0) return makeResult(candidates[0]);

  // Fallback: match across all modules
  if (moduleFilter && symbols.length > 0) {
    const fallback = symbols.find(
      (s) => s.name.toLowerCase() === searchPattern.toLowerCase(),
    );
    if (fallback) return makeResult(fallback);
  }

  return null;
}
