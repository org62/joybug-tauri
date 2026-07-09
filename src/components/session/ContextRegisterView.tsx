import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { useSessionContext } from '@/contexts/SessionContext';
import { RegisterView, SerializableThreadContext, XmmFormat, X64_REGISTERS, ARM64_REGISTERS } from '@/components/RegisterView';
import { RegisterEditDialog, SymbolResolverWithName } from '@/components/RegisterEditDialog';
import { useRegisterDereference } from '@/hooks/useRegisterDereference';
import { useLocalStorageState } from '@/hooks/useLocalStorageState';
import { RegisterContext } from '@/lib/hexUtils';
import { resolveSymbol } from '@/lib/symbolUtils';
import { AlertCircle } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';

function computeChangedRegisters(
  prev: SerializableThreadContext | undefined,
  current: SerializableThreadContext
): Set<string> {
  if (!prev || prev.arch !== current.arch) return new Set();
  const changed = new Set<string>();
  for (const key of Object.keys(current)) {
    if (key === "arch") continue;
    if ((current as unknown as Record<string, string>)[key] !== (prev as unknown as Record<string, string>)[key]) {
      changed.add(key);
    }
  }
  return changed;
}

const REGISTERS_32BIT = new Set(['eflags', 'cpsr']);

interface EditingRegister {
  name: string;
  field: string;
  value: string;
  hexWidth: number;
}

export const ContextRegisterView = () => {
  const sessionData = useSessionContext();
  const currentEvent = sessionData?.session?.current_event;
  const sessionId = sessionData?.session?.id;

  // Use displayStatus (debounced) to prevent flicker during stepping
  const displayStatus = sessionData?.displayStatus;
  const context = displayStatus === "Paused" ? currentEvent?.context : undefined;

  // x64 view options (persisted across sessions)
  const [showXmm, setShowXmm] = useLocalStorageState('registers.showXmm', false);
  const [showDr, setShowDr] = useLocalStorageState('registers.showDr', false);
  const [xmmFormat, setXmmFormat] = useLocalStorageState<XmmFormat>('registers.xmmFormat', 'hex');

  // Fetch dereference data for all registers (use displayStatus to prevent flicker)
  const { getDereferenceForAddress } = useRegisterDereference(context, sessionId, displayStatus, showDr);

  // Track previous context to detect changed registers
  const prevContextRef = useRef<SerializableThreadContext | undefined>(undefined);

  const changedRegisters = useMemo(
    () => context ? computeChangedRegisters(prevContextRef.current, context) : new Set<string>(),
    [context]
  );

  // Update ref after render so next render can diff against it; clear when session ends/resumes
  useEffect(() => {
    if (!sessionId || displayStatus !== "Paused") {
      prevContextRef.current = undefined;
    } else if (context) {
      prevContextRef.current = context;
    }
  }, [context, sessionId, displayStatus]);

  // Dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingRegister, setEditingRegister] = useState<EditingRegister | null>(null);

  // Reset dialog state when session ends or resumes
  useEffect(() => {
    if (!sessionId || displayStatus !== "Paused") {
      setDialogOpen(false);
      setEditingRegister(null);
    }
  }, [sessionId, displayStatus]);

  // Build RegisterContext from thread context, deriving fields from RegisterDef arrays
  const registers: RegisterContext = useMemo(() => {
    if (!context) return {};
    const defs = context.arch === 'X64' ? X64_REGISTERS : context.arch === 'Arm64' ? ARM64_REGISTERS : [];
    const ctx = context as unknown as Record<string, string>;
    return Object.fromEntries(defs.map(d => [d.field, ctx[d.field]]));
  }, [context]);

  // Symbol resolver that also returns the matched symbol's display name
  const resolveSymbolWithName: SymbolResolverWithName = useCallback(async (name: string) => {
    if (!sessionData?.searchSymbols) return null;
    try {
      return await resolveSymbol(sessionData.searchSymbols, name);
    } catch {
      return null;
    }
  }, [sessionData?.searchSymbols]);

  // Open dialog on double-click
  const handleRequestEdit = useCallback((field: string, currentValue: string) => {
    // Look up display name from register defs (handles FP/LR aliases on ARM64)
    const allDefs = [...X64_REGISTERS, ...ARM64_REGISTERS];
    const def = allDefs.find(d => d.field === field);
    const name = def?.name ?? field.toUpperCase();
    const hexWidth = REGISTERS_32BIT.has(field) ? 8 : 16;
    setEditingRegister({ name, field, value: currentValue, hexWidth });
    setDialogOpen(true);
  }, []);

  // Commit register value
  const handleCommit = useCallback((field: string, hexValue: string) => {
    if (!sessionId) return;
    invoke('request_set_register', {
      sessionId,
      registerName: field,
      value: '0x' + hexValue,
    }).catch((err) => {
      console.error('Failed to set register:', err);
    });
  }, [sessionId]);

  // Only allow editing when paused
  const onRegisterEdit = displayStatus === "Paused" ? handleRequestEdit : undefined;

  if (context) {
    return (
      <>
        <RegisterView
          context={context}
          getDereferenceForAddress={getDereferenceForAddress}
          changedRegisters={changedRegisters}
          onRegisterEdit={onRegisterEdit}
          showXmm={showXmm}
          showDr={showDr}
          xmmFormat={xmmFormat}
          onToggleXmm={() => setShowXmm((v) => !v)}
          onToggleDr={() => setShowDr((v) => !v)}
          onXmmFormatChange={setXmmFormat}
        />
        {editingRegister && (
          <RegisterEditDialog
            open={dialogOpen}
            onOpenChange={setDialogOpen}
            registerName={editingRegister.name}
            registerField={editingRegister.field}
            currentValue={editingRegister.value}
            onCommit={handleCommit}
            registers={registers}
            resolveSymbolWithName={resolveSymbolWithName}
            hexWidth={editingRegister.hexWidth}
          />
        )}
      </>
    );
  }
  return (
    <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
      <div className="text-center">
        <AlertCircle className="h-12 w-12 mx-auto mb-4 opacity-50" />
        <p className="text-base font-medium">No register data available</p>
        <p className="text-sm mt-1">Register values will appear here when debugging</p>
      </div>
    </div>
  );
};
