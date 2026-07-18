import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { FileUp, Save, SaveAll, X, FileSearch } from "lucide-react";

import { Page } from "@/components/ui/page";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DockWindowsMenu, DockWindowsMenuTab } from "@/components/DockWindowsMenu";
import { DockPanel, PanelBody } from "@/components/ui/panel";
import { LayoutData, TabData } from "rc-dock";
import DockingLayout, { DockingLayoutRef } from "@/components/DockingLayout";
import { DockingConfig } from "@/hooks/useDocking";
import { HexView } from "@/components/HexView";
import { AssemblyView } from "@/components/AssemblyView";
import { PeStructureTree } from "@/components/pe/PeStructureTree";
import { PeSymbolsView, PeSymbol } from "@/components/pe/PeSymbolsView";
import { PeStringsView } from "@/components/pe/PeStringsView";
import { OpenPeDialog } from "@/components/pe/OpenPeDialog";
import { Download } from "lucide-react";
import { HexDataSource } from "@/hooks/useHexEditor";
import { AsmDisassembleFn, Instruction } from "@/hooks/useAssemblyView";
import { ModuleExtraInfo } from "@/hooks/useModuleInfo";
import { PeScanFn, PeStringScanResult } from "@/hooks/usePeStringScan";
import { SymbolResolver } from "@/lib/hexUtils";
import { PeMapping, AddrMode, ADDR_MODE_LABELS, buildMapping, formatOffset, formatVa, rvaToVa, tripleFromInput } from "@/lib/peAddress";
import { applyFieldEdit } from "@/lib/peDecode";
import { memoryNavigation, disassemblyNavigation } from "@/lib/navigationStore";
import { NavHistoryStore } from "@/lib/navHistory";
import { useNavHistoryDock } from "@/hooks/useNavHistoryDock";
import { moduleBasename } from "@/lib/sessionHelpers";
import { toastError, toastSuccess } from "@/lib/logger";
import { formatTauriError } from "@/lib/sessionHelpers";

interface PeFileSummary {
  path: string;
  size: number;
  base: string;
  info: ModuleExtraInfo;
  symbols_loaded: boolean;
  symbol_count: number;
}

// VA to start disassembling at: the entry point, else the first executable
// section, else the image base. Disassembly is VA-addressed (base + RVA).
function initialDisasmVa(info: ModuleExtraInfo, mapping: PeMapping): bigint {
  const entryRva = info.nt_headers.OptionalHeader.AddressOfEntryPoint;
  if (entryRva) return rvaToVa(mapping, entryRva);
  const exec = mapping.sections.find((s) => s.exec);
  return rvaToVa(mapping, exec ? exec.virtAddr : 0);
}

interface PeReaderContextValue {
  summary: PeFileSummary | null;
  mapping: PeMapping | null;
  mode: AddrMode;
  hexDataSource: HexDataSource | null;
  disassemble: AsmDisassembleFn | null;
  initialAddress: bigint;
  symbolsRefreshKey: string;
  setField: (field: string, value: number) => void;
  searchSymbols: (pattern: string, limit: number) => Promise<PeSymbol[]>;
  /** Resolve a symbol name typed in a goto box to its VA. */
  resolveSymbol: SymbolResolver;
  stringScan: PeScanFn;
  onGoToHex: (offset: number) => void;
  onGoToDisasm: (va: bigint) => void;
  /** Select the raw bytes of the given header fields in the hex view. */
  onSelectField: (...fields: string[]) => void;
  /** Unified back/forward history for this PE reader's dock (per open file). */
  navHistory: NavHistoryStore;
}

const PeReaderContext = createContext<PeReaderContextValue | null>(null);
const usePeReader = () => {
  const ctx = useContext(PeReaderContext);
  if (!ctx) throw new Error("usePeReader must be used within PeReaderContext");
  return ctx;
};

// Placeholder shown in a tab before any file is opened.
const NoFilePlaceholder: React.FC = () => (
  <EmptyState
    icon={<FileSearch className="h-12 w-12 mx-auto mb-4 opacity-50" />}
    title="No PE file open"
    subtitle="Use “Open…” to load an executable or DLL"
  />
);

const PeStructuresTab: React.FC = () => {
  const { summary, mapping, mode, setField, onGoToHex, onGoToDisasm, onSelectField } = usePeReader();
  // The tree's big groups (imports/exports/exception) virtualize inline against
  // this panel viewport, so the panel has a single scroll region.
  const viewportRef = useRef<HTMLDivElement>(null);
  if (!summary || !mapping) return <NoFilePlaceholder />;
  return (
    <DockPanel>
      <PanelBody viewportRef={viewportRef}>
        <PeStructureTree
          info={summary.info}
          mapping={mapping}
          mode={mode}
          scrollRef={viewportRef}
          onSetField={setField}
          onGoToHex={onGoToHex}
          onGoToDisasm={onGoToDisasm}
          onSelectField={onSelectField}
        />
      </PanelBody>
    </DockPanel>
  );
};

const PeHexTab: React.FC = () => {
  const { summary, hexDataSource, mapping, mode, resolveSymbol } = usePeReader();
  if (!summary || !hexDataSource || !mapping) return <NoFilePlaceholder />;
  // Key on path so opening a different file remounts with fresh internal state.
  return (
    <HexView
      key={summary.path}
      memoryViewId="pe-hex"
      dataSource={hexDataSource}
      resolveSymbol={resolveSymbol}
      addressFormatter={(abs) => formatOffset(mapping, abs, mode)}
      translateGotoInput={(addr) => BigInt(tripleFromInput(mapping, addr, mode).file)}
    />
  );
};

const PeDisasmTab: React.FC = () => {
  const { summary, disassemble, initialAddress, mapping, mode, symbolsRefreshKey, resolveSymbol, navHistory } = usePeReader();
  if (!summary || !disassemble || !mapping) return <NoFilePlaceholder />;
  return (
    <AssemblyView
      key={summary.path}
      disassemble={disassemble}
      initialAddress={initialAddress}
      symbolsRefreshKey={symbolsRefreshKey}
      resolveSymbol={resolveSymbol}
      addressFormatter={(va) => formatVa(mapping, va, mode)}
      translateGotoInput={(addr) => tripleFromInput(mapping, addr, mode).va}
      navHistory={navHistory}
    />
  );
};

const PeSymbolsTab: React.FC = () => {
  const { summary, mapping, mode, searchSymbols, onGoToHex, onGoToDisasm } = usePeReader();
  if (!summary || !mapping) return <NoFilePlaceholder />;
  return (
    <PeSymbolsView
      searchSymbols={searchSymbols}
      symbolsLoaded={summary.symbols_loaded}
      symbolCount={summary.symbol_count}
      mapping={mapping}
      mode={mode}
      onGoToHex={onGoToHex}
      onGoToDisasm={onGoToDisasm}
    />
  );
};

const PeStringsTab: React.FC = () => {
  const { summary, mapping, mode, stringScan, onGoToHex, onGoToDisasm } = usePeReader();
  if (!summary || !mapping) return <NoFilePlaceholder />;
  return (
    <PeStringsView
      scan={stringScan}
      fileName={moduleBasename(summary.path)}
      mapping={mapping}
      mode={mode}
      onGoToHex={onGoToHex}
      onGoToDisasm={onGoToDisasm}
    />
  );
};

// The one source of truth for the dock tabs — the dock config, the content
// map, and the Windows menu all derive from it.
const PE_TAB_DEFS = [
  { id: "pe-structures", title: "Structures", content: <PeStructuresTab /> },
  { id: "pe-symbols", title: "Symbols", content: <PeSymbolsTab /> },
  { id: "pe-strings", title: "Strings", content: <PeStringsTab /> },
  { id: "pe-disassembly", title: "Disassembly", content: <PeDisasmTab /> },
  { id: "pe-hex", title: "Hex", content: <PeHexTab /> },
];

// Stable dock config — tab content reads live data from PeReaderContext.
const PE_DOCK_CONFIG: DockingConfig = {
  storagePrefix: "pe-reader-dock",
  initialLayout: {
    dockbox: {
      mode: "horizontal",
      children: [
        { size: 360, tabs: [{ id: "pe-structures" }, { id: "pe-symbols" }, { id: "pe-strings" }], activeId: "pe-structures" },
        { tabs: [{ id: "pe-disassembly" }], activeId: "pe-disassembly" },
        { tabs: [{ id: "pe-hex" }], activeId: "pe-hex" },
      ],
    },
  } as LayoutData,
  initialTabContents: Object.fromEntries(
    PE_TAB_DEFS.map((t) => [t.id, { ...t, closable: true }]),
  ) as { [key: string]: TabData },
  tabContentMap: Object.fromEntries(PE_TAB_DEFS.map((t) => [t.id, t.content])),
};

// Tab list for the Windows menu (toggle a closed tab back on / reset layout).
const PE_TABS: DockWindowsMenuTab[] = PE_TAB_DEFS.map(({ id, title }) => ({ id, label: title }));

// The open file survives route changes: the page unmounts when navigating to
// another section, but the backend buffer stays open (it's only released on an
// explicit Close or when a different file is opened), and this module-level
// snapshot rehydrates the page state on remount.
let savedPeState: {
  summary: PeFileSummary; dirty: boolean; mode: AddrMode; symbolsRefreshKey: string;
} | null = null;

export default function PeReader() {
  const [summary, setSummary] = useState<PeFileSummary | null>(() => savedPeState?.summary ?? null);
  const [dirty, setDirty] = useState(() => savedPeState?.dirty ?? false);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<AddrMode>(() => savedPeState?.mode ?? "va");
  const [openDialog, setOpenDialog] = useState(false);
  const [symbolsRefreshKey, setSymbolsRefreshKey] = useState(() => savedPeState?.symbolsRefreshKey ?? "");
  const dockingRef = useRef<DockingLayoutRef>(null);

  useEffect(() => {
    savedPeState = summary ? { summary, dirty, mode, symbolsRefreshKey } : null;
  }, [summary, dirty, mode, symbolsRefreshKey]);

  const path = summary?.path ?? null;
  const [searchParams, setSearchParams] = useSearchParams();

  const mapping = useMemo<PeMapping | null>(
    () => (summary ? buildMapping(summary.info, BigInt(summary.base)) : null),
    [summary],
  );

  // Parse a PE file and load it into the views, with an optional load base and PDB.
  const loadPath = useCallback(async (selected: string, base?: string | null, pdbPath?: string | null) => {
    try {
      setBusy(true);
      const result = await invoke<PeFileSummary>("pe_open", { path: selected, base: base ?? null, pdbPath: pdbPath ?? null });
      // Release the previous file's backend buffer when switching files.
      if (path && path !== selected) invoke("pe_close", { path }).catch(() => {});
      setSummary(result);
      setDirty(false);
      setSymbolsRefreshKey(`${selected}:${result.symbol_count}`);
    } catch (err) {
      toastError(`Failed to open PE file: ${formatTauriError(err)}`);
    } finally {
      setBusy(false);
    }
  }, [path]);

  // Download/parse symbols for the open file (allows a symbol-server download),
  // then re-symbolize the disassembly.
  const loadSymbols = useCallback(async () => {
    if (!path) return;
    try {
      setBusy(true);
      const res = await invoke<{ loaded: boolean; count: number; error: string | null }>("pe_load_symbols", { path });
      if (res.loaded) {
        setSummary((prev) => (prev ? { ...prev, symbols_loaded: true, symbol_count: res.count } : prev));
        setSymbolsRefreshKey(`${path}:${res.count}`);
        toastSuccess(`Loaded ${res.count} symbols`);
      } else {
        toastError(res.error ? `Symbol load failed: ${res.error}` : "Symbols not found (PDB mismatch or missing)");
      }
    } catch (err) {
      toastError(`Symbol load failed: ${formatTauriError(err)}`);
    } finally {
      setBusy(false);
    }
  }, [path]);

  const searchSymbols = useCallback((pattern: string, limit: number): Promise<PeSymbol[]> => {
    if (!path) return Promise.resolve([]);
    return invoke<PeSymbol[]>("pe_search_symbols", { path, pattern, limit });
  }, [path]);

  // Symbol resolution for the disassembly/hex goto boxes. An exact name match
  // wins (case-insensitive, `module!` prefix ignored); otherwise a unique
  // substring match resolves — anything ambiguous stays unresolved.
  const resolveSymbol = useCallback<SymbolResolver>(async (name) => {
    const bare = name.slice(name.indexOf("!") + 1).trim();
    if (!bare) return null;
    const hits = await searchSymbols(bare, 50);
    const lower = bare.toLowerCase();
    const hit = hits.find((s) => s.name.toLowerCase() === lower) ?? (hits.length === 1 ? hits[0] : undefined);
    return hit ? BigInt(hit.va) : null;
  }, [searchSymbols]);

  const stringScan = useCallback<PeScanFn>((minLength, encodings, contains) => {
    if (!path) return Promise.resolve({ hits: [], capped: false });
    return invoke<PeStringScanResult>("pe_string_scan", { path, minLength, encodings, contains });
  }, [path]);

  // Deep-link support: /pe?path=<file>&base=<hex> opens on mount.
  useEffect(() => {
    const deepLink = searchParams.get("path");
    if (deepLink && !summary && !busy) {
      loadPath(deepLink, searchParams.get("base"));
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, summary, busy, loadPath, setSearchParams]);

  const handleSave = useCallback(async (saveAs: boolean) => {
    if (!path) return;
    try {
      let target: string | null = null;
      if (saveAs) {
        target = await saveFileDialog({ defaultPath: path });
        if (!target) return;
      }
      setBusy(true);
      await invoke("pe_save", { path, saveAs: target });
      setDirty(false);
      toastSuccess(saveAs ? `Saved copy to ${moduleBasename(target!)}` : "File saved");
    } catch (err) {
      toastError(`Failed to save PE file: ${formatTauriError(err)}`);
    } finally {
      setBusy(false);
    }
  }, [path]);

  const handleClose = useCallback(() => {
    if (path) invoke("pe_close", { path }).catch(() => {});
    setSummary(null);
    setDirty(false);
  }, [path]);

  // Data source for the hex view: read/write the server-side file buffer.
  const hexDataSource: HexDataSource | null = useMemo(() => {
    if (!path) return null;
    return {
      persistKey: `pe:${path}`,
      readBytes: async (offset, size) => {
        // The backend returns a raw IPC payload (ArrayBuffer), not a JSON array.
        const bytes = await invoke<ArrayBuffer>("pe_read_bytes", { path, offset, size });
        return new Uint8Array(bytes);
      },
      writeBytes: async (offset, data) => {
        await invoke("pe_write_bytes", { path, offset, data });
        setDirty(true);
      },
    };
  }, [path]);

  const disassemble: AsmDisassembleFn | null = useMemo(() => {
    if (!path) return null;
    // AssemblyView passes a VA; the backend maps it to a file offset to read bytes.
    return (va, count) => invoke<Instruction[]>("pe_disassemble", { path, va: Number(va), count });
  }, [path]);

  // Unified back/forward history, reset per opened file (addresses from a
  // previously opened PE would be meaningless).
  const navHistory = useMemo(() => new NavHistoryStore("pe-disassembly"), [summary?.path]);

  // Controller, tab-switch recording, mouse buttons.
  const { onTabSwitch } = useNavHistoryDock(navHistory, dockingRef);

  // Jump to a coordinate in a tab: hex is file-offset addressed, disassembly is
  // VA addressed. `addr` is already in that tab's coordinate space.
  const goTo = useCallback((tab: string, addr: bigint) => {
    if (tab === navHistory.disasmTabId) navHistory.recordJumpToDisasm();
    dockingRef.current?.showTab(tab);
    const s = `0x${addr.toString(16)}`;
    if (tab === "pe-hex") memoryNavigation.request(s);
    else disassemblyNavigation.request(s);
  }, [navHistory]);

  const onGoToHex = useCallback((offset: number) => goTo("pe-hex", BigInt(offset)), [goTo]);
  const onGoToDisasm = useCallback((va: bigint) => goTo("pe-disassembly", va), [goTo]);

  // Select a header field's raw bytes in the hex view. The backend owns the
  // field layout tables; multiple fields (e.g. a Major/Minor version pair)
  // merge into one contiguous selection.
  const onSelectField = useCallback(async (...fields: string[]) => {
    if (!path || !fields.length) return;
    try {
      const spans = await Promise.all(
        fields.map((field) => invoke<[number, number]>("pe_field_span", { path, field })),
      );
      const start = Math.min(...spans.map(([offset]) => offset));
      const end = Math.max(...spans.map(([offset, len]) => offset + len));
      dockingRef.current?.showTab("pe-hex");
      memoryNavigation.request({ address: `0x${start.toString(16)}`, selectLength: end - start });
    } catch (err) {
      toastError(`Failed to locate field: ${formatTauriError(err)}`);
    }
  }, [path]);

  // Write a symbolic flag/enum field, mirroring the edit into the local parsed
  // copy (the backend edits raw bytes and doesn't re-ship the structures).
  const setField = useCallback(async (field: string, value: number) => {
    if (!path) return;
    try {
      await invoke("pe_set_field", { path, field, value });
      setSummary((prev) => (prev ? { ...prev, info: applyFieldEdit(prev.info, field, value) } : prev));
      setDirty(true);
    } catch (err) {
      toastError(`Failed to edit field: ${formatTauriError(err)}`);
    }
  }, [path]);

  const ctxValue: PeReaderContextValue = useMemo(() => ({
    summary,
    mapping,
    mode,
    hexDataSource,
    disassemble,
    initialAddress: summary && mapping ? initialDisasmVa(summary.info, mapping) : 0n,
    symbolsRefreshKey,
    setField,
    searchSymbols,
    resolveSymbol,
    stringScan,
    onGoToHex,
    onGoToDisasm,
    onSelectField,
    navHistory,
  }), [summary, mapping, mode, hexDataSource, disassemble, symbolsRefreshKey, setField, searchSymbols, resolveSymbol, stringScan, onGoToHex, onGoToDisasm, onSelectField, navHistory]);

  return (
    <Page scroll={false} container={false}>
      <div className="flex flex-col h-full min-h-0">
        {/* Toolbar */}
        <div className="flex items-center gap-2 px-3 py-2 border-b shrink-0 select-none">
          <Button size="sm" variant="outline" onClick={() => setOpenDialog(true)} disabled={busy}>
            <FileUp className="mr-1 h-4 w-4" /> Open…
          </Button>
          <Button size="sm" variant="outline" onClick={() => handleSave(false)} disabled={busy || !path || !dirty}>
            <Save className="mr-1 h-4 w-4" /> Save
          </Button>
          <Button size="sm" variant="outline" onClick={() => handleSave(true)} disabled={busy || !path}>
            <SaveAll className="mr-1 h-4 w-4" /> Save As…
          </Button>
          {path && !summary?.symbols_loaded && (
            <Button size="sm" variant="outline" onClick={loadSymbols} disabled={busy} title="Load symbols (allows symbol-server download)">
              <Download className="mr-1 h-4 w-4" /> Load Symbols
            </Button>
          )}
          {path && (
            <Button size="sm" variant="ghost" onClick={handleClose} disabled={busy}>
              <X className="mr-1 h-4 w-4" /> Close
            </Button>
          )}
          {path && (
            <Select value={mode} onValueChange={(v) => setMode(v as AddrMode)}>
              <SelectTrigger size="xs" className="w-32" title="Address display mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(["va", "rva", "file"] as AddrMode[]).map((m) => (
                  <SelectItem key={m} value={m} className="text-xs">{ADDR_MODE_LABELS[m]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <div className="ml-2 flex-1 min-w-0 text-sm font-mono truncate text-muted-foreground" title={path ?? undefined}>
            {path ? moduleBasename(path) : "No PE file open"}
            {dirty && <span className="ml-1 text-yellow-500">●</span>}
            {summary?.symbols_loaded && <span className="ml-2 text-xs text-green-500">{summary.symbol_count} symbols</span>}
          </div>
          <DockWindowsMenu dockingRef={dockingRef} tabs={PE_TABS} />
        </div>

        {/* Docked views */}
        <div className="relative flex-1 min-h-0">
          <PeReaderContext.Provider value={ctxValue}>
            <DockingLayout ref={dockingRef} {...PE_DOCK_CONFIG} onTabSwitch={onTabSwitch} className="absolute inset-0" />
          </PeReaderContext.Provider>
        </div>
      </div>

      <OpenPeDialog
        open={openDialog}
        onOpenChange={setOpenDialog}
        onConfirm={(p, base, pdb) => loadPath(p, base, pdb)}
      />
    </Page>
  );
}
