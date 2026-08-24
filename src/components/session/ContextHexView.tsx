import { useCallback, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useSessionContext, Symbol } from '@/contexts/SessionContext';
import { HexView } from '@/components/HexView';
import { ViewMode } from '@/lib/hexUtils';
import { contextToRegisters } from '@/lib/sessionHelpers';
import { useSymbolResolver } from '@/hooks/useSymbolResolver';
import { HexExtraLabel, HexSymbolSource } from '@/hooks/useHexSymbols';

/** Stable "no bookmarks" identity, see `extraLabels` below. */
const NO_EXTRA_LABELS: HexExtraLabel[] = [];

interface ContextHexViewProps {
  memoryViewId?: string;
  initialAddress?: bigint;
  initialViewMode?: ViewMode;
  /** Re-centre on this address (and make it the offset origin) whenever
   *  `followKey` changes — see HexView. */
  followAddress?: bigint;
  followKey?: string;
  /** "private" keeps an embedded instance off the shared "Go to Memory" channel. */
  navScope?: "shared" | "private";
}

export const ContextHexView = ({ memoryViewId, initialAddress, initialViewMode, followAddress, followKey, navScope }: ContextHexViewProps) => {
  const sessionData = useSessionContext();
  const context = sessionData?.session?.current_event?.context;
  const sessionId = sessionData?.session?.id;

  // Extract registers from thread context
  const registers = useMemo(() => contextToRegisters(context), [context]);

  const resolveSymbolFn = useSymbolResolver();

  // Debounced status, like every other tab: Stopped/Paused apply immediately,
  // only the Paused→Running flip is delayed so quick steps don't flicker.
  const sessionStatus = sessionData?.displayStatus;
  const statusString = typeof sessionStatus === 'string' ? sessionStatus : undefined;

  const { setHardwareBreakpoint } = sessionData.breakpointState;
  const { addBookmark, bookmarks } = sessionData.bookmarkState;

  // Module symbols for the "show symbols" rows. OOB, so it works Paused,
  // Running and non-invasive Open; stable identity keeps the hook's dep quiet.
  const symbolSource = useCallback<HexSymbolSource>(async (start, size) => {
    if (!sessionId) return [];
    const list = await invoke<Symbol[]>('get_symbols_in_range', {
      sessionId,
      start: `0x${start.toString(16)}`,
      size,
    });
    // Parse to bigint once per fetch, not once per row-model rebuild.
    return list.map((s) => ({ address: BigInt(s.va), label: s.display_name }));
  }, [sessionId]);

  // Resolved bookmarks are user labels pointing at memory too; the backend
  // formats `resolved_address` as `0x…` exactly when it resolved.
  // `bookmarks` gets a fresh identity on every pause, so collapse the (common)
  // empty result onto one shared reference — otherwise the hex row model, and
  // the whole virtualized list with it, rebuilds on each step for no content.
  const extraLabels = useMemo<HexExtraLabel[]>(() => {
    const labels = bookmarks
      .filter((b) => b.is_resolved && b.resolved_address.startsWith('0x'))
      .map((b) => ({
        address: BigInt(b.resolved_address),
        label: { text: b.name || b.comment || 'bookmark', kind: 'bookmark' as const },
      }));
    return labels.length === 0 ? NO_EXTRA_LABELS : labels;
  }, [bookmarks]);

  return (
    <HexView
      sessionId={sessionId}
      memoryViewId={memoryViewId}
      sessionStatus={statusString}
      registers={registers}
      resolveSymbol={resolveSymbolFn}
      symbolsRefreshKey={sessionData.symbolsRefreshKey}
      initialAddress={initialAddress}
      initialViewMode={initialViewMode}
      followAddress={followAddress}
      followKey={followKey}
      navScope={navScope}
      symbolSource={symbolSource}
      extraLabels={extraLabels}
      onSetHardwareBreakpoint={setHardwareBreakpoint}
      onAddBookmark={(address, valueType) => addBookmark({ kind: 'value', address, valueType })}
      onFindAccesses={sessionData.onFindAccesses}
      onShowInMemoryRegions={sessionData.onNavigateToMemoryRegion}
    />
  );
};
