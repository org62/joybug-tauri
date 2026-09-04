import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { useSessionContext } from '@/contexts/SessionContext';
import { RegisterView, SerializableThreadContext, XmmFormat, X64_REGISTERS, ARM64_REGISTERS, X86_REGISTERS, registerDefsFor } from '@/components/RegisterView';
import { RegisterEditDialog } from '@/components/RegisterEditDialog';
import { useRegisterDereference } from '@/hooks/useRegisterDereference';
import { useLocalStorageState } from '@/hooks/useLocalStorageState';
import { useSymbolResolverWithName } from '@/hooks/useSymbolResolver';
import { RegisterContext } from '@/lib/hexUtils';
import { AlertCircle } from 'lucide-react';
import { EmptyState, ProcessUnavailableState } from '@/components/ui/empty-state';
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
    const defs = registerDefsFor(context.arch);
    const ctx = context as unknown as Record<string, string>;
    return Object.fromEntries(defs.map(d => [d.field, ctx[d.field]]));
  }, [context]);

  const resolveSymbolWithName = useSymbolResolverWithName();

  // Open dialog on double-click
  const handleRequestEdit = useCallback((field: string, currentValue: string) => {
    // Look up display name from register defs (handles FP/LR aliases on ARM64)
    const allDefs = [...X64_REGISTERS, ...ARM64_REGISTERS, ...X86_REGISTERS];
    const def = allDefs.find(d => d.field === field);
    const name = def?.name ?? field.toUpperCase();
    // The backend zero-pads every value to its register width (8 hex digits
    // for 32-bit registers — eflags, cpsr, the whole x86 file — else 16).
    const hexWidth = currentValue.replace(/^0x/i, '').length || 16;
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
  // No process → the shared no-process state; otherwise (running, or paused
  // without a context yet) the generic placeholder.
  if (sessionData?.session && !sessionData.canUseMemoryOps) {
    return <ProcessUnavailableState icon={AlertCircle} what="Registers" />;
  }
  return (
    <EmptyState
      icon={<AlertCircle className="h-12 w-12 mx-auto mb-4 opacity-50" />}
      title="No register data available"
      subtitle="Register values will appear here when debugging"
    />
  );
};
