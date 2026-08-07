import { parseAddress } from "@/lib/hexUtils";
import type { Module } from "@/contexts/SessionContext";

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

/** The subset of the session Module shape needed for module-name resolution. */
export type ModuleRef = Pick<Module, "name" | "base_address">;

/** Basename of a module path ("C:\\Windows\\System32\\ntdll.dll" -> "ntdll.dll"). */
export function moduleBasename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** Directory of a path ("C:\\a\\b.c" -> "C:\\a"); "" when there is no separator. */
export function pathDirname(path: string): string {
  const idx = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return idx >= 0 ? path.slice(0, idx) : "";
}

/**
 * If `name` is a loaded module's name ("orig", "orig.exe", "ntdll", full path
 * basename), returns that module's base address. Matches the `module+0x...`
 * labels the disassembly shows in no-symbols mode (backend `module_offset_label`
 * in src-tauri session/helpers.rs), so pasting one back navigates to the right
 * place instead of hitting the fuzzy symbol search.
 */
function resolveModuleName(
  modules: ModuleRef[],
  name: string,
): ResolvedSymbol | null {
  const want = name.toLowerCase();
  for (const mod of modules) {
    const basename = moduleBasename(mod.name).toLowerCase();
    // Strip the final extension whatever it is, mirroring the backend's
    // `extract_module_name` (Rust `file_stem`) that produces the labels.
    const stem = basename.replace(/\.[^.]+$/, "");
    if (basename === want || stem === want) {
      const address = parseAddress(mod.base_address);
      if (address !== null) return { address, displayName: basename };
    }
  }
  return null;
}

/**
 * Resolves a symbol name (with optional "module!symbol" syntax) to an address.
 * Bare module names resolve to the module base; otherwise returns the best
 * symbol match along with its display name, or null if not found.
 */
export async function resolveSymbol(
  searchSymbols: SearchSymbolsFn,
  name: string,
  modules?: ModuleRef[],
): Promise<ResolvedSymbol | null> {
  if (modules) {
    const moduleMatch = resolveModuleName(modules, name.trim());
    if (moduleMatch) return moduleMatch;
  }

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
