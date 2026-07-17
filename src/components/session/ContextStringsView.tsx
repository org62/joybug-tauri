import { useEffect } from 'react';
import { useSessionContext } from '@/contexts/SessionContext';
import { useStringScan, StringScanScope } from '@/hooks/useStringScan';
import { StringsPanel } from '@/components/StringsPanel';
import { Input } from '@/components/ui/input';
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from '@/components/ui/select';
import { moduleBasename } from '@/lib/sessionHelpers';
import { parseAddressToNumber } from '@/lib/hexUtils';

const SCOPE_OPTIONS: { value: StringScanScope; label: string }[] = [
  { value: 'module', label: 'Module' },
  { value: 'modules', label: 'All modules' },
  { value: 'readable', label: 'All readable memory' },
  { value: 'writable', label: 'Writable memory' },
  { value: 'executable', label: 'Executable memory' },
  { value: 'private', label: 'Private memory (heap/stack)' },
  { value: 'mapped', label: 'Mapped files' },
  { value: 'range', label: 'Custom range' },
];

/// Region filter each whole-address-space scope narrows to.
const SCOPE_REGION_FILTERS: Partial<Record<StringScanScope, string>> = {
  modules: 'image',
  readable: 'readable',
  writable: 'writable',
  executable: 'executable',
  private: 'private',
  mapped: 'mapped',
};

export const ContextStringsView = () => {
  const sessionData = useSessionContext();
  const canUse = sessionData.canUseMemoryOps;
  const sessionId = sessionData?.session?.id;
  const onNavigateToMemory = sessionData.onNavigateToMemory;
  const onNavigateToDisassembly = sessionData.onNavigateToDisassembly;
  const modules = sessionData?.modules ?? [];
  const loadModules = sessionData?.loadModules;

  const scan = useStringScan(sessionId, canUse);

  // Load the module list so the user can pick which module to scan.
  useEffect(() => {
    if (sessionId && canUse) loadModules?.();
  }, [sessionId, canUse, loadModules]);

  const rangeStart = parseAddressToNumber(scan.rangeStart);
  const rangeEnd = parseAddressToNumber(scan.rangeEnd);
  const rangeValid = rangeStart !== null && rangeEnd !== null && rangeEnd > rangeStart;

  const startScan = () => {
    if (scan.scope === 'module') {
      const mod = modules.find((m) => m.base_address === scan.selectedModuleBase);
      if (!mod) return;
      scan.handleScan({ startAddress: parseInt(mod.base_address, 16), size: mod.size, regionFilter: 'readable' });
    } else if (scan.scope === 'range') {
      if (!rangeValid) return;
      scan.handleScan({ startAddress: rangeStart, size: rangeEnd - rangeStart, regionFilter: 'readable' });
    } else {
      scan.handleScan({ startAddress: null, size: null, regionFilter: SCOPE_REGION_FILTERS[scan.scope] ?? 'readable' });
    }
  };

  const scanDisabled =
    !canUse || scan.isScanning ||
    (scan.scope === 'module' && !scan.selectedModuleBase) ||
    (scan.scope === 'range' && !rangeValid);

  const scopeControls = (
    <>
      <Select
        value={scan.scope}
        onValueChange={(v) => scan.setScope(v as StringScanScope)}
        disabled={!canUse}
      >
        <SelectTrigger size="xs" className="w-44 shrink-0">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {SCOPE_OPTIONS.map((o) => (
            <SelectItem key={o.value} value={o.value} className="text-xs">
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {scan.scope === 'module' && (
        <Select
          value={scan.selectedModuleBase ?? ''}
          onValueChange={scan.setSelectedModuleBase}
          disabled={!canUse}
        >
          <SelectTrigger size="xs" className="flex-1 min-w-0">
            <SelectValue placeholder="Select a module..." />
          </SelectTrigger>
          <SelectContent>
            {modules.map((m) => (
              <SelectItem key={m.base_address} value={m.base_address} className="text-xs">
                <span className="font-mono">{moduleBasename(m.name)}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {scan.scope === 'range' && (
        <>
          <Input
            type="text"
            inputSize="xs"
            placeholder="Start (hex)"
            value={scan.rangeStart}
            onChange={(e) => scan.setRangeStart(e.target.value)}
            className="flex-1 min-w-0 font-mono"
            disabled={!canUse}
          />
          <Input
            type="text"
            inputSize="xs"
            placeholder="End (hex)"
            value={scan.rangeEnd}
            onChange={(e) => scan.setRangeEnd(e.target.value)}
            className="flex-1 min-w-0 font-mono"
            disabled={!canUse}
          />
        </>
      )}
    </>
  );

  return (
    <StringsPanel
      scan={scan}
      scopeControls={scopeControls}
      onScan={startScan}
      scanDisabled={scanDisabled}
      controlsDisabled={!canUse}
      unavailable={sessionData.session && !canUse
        ? { title: 'Strings unavailable', subtitle: 'Open or run a process to scan for strings' }
        : null}
      columnWidthsKey="stringsView"
      onNavigateToMemory={onNavigateToMemory}
      onNavigateToDisassembly={onNavigateToDisassembly}
      focusTabId="strings"
    />
  );
};
