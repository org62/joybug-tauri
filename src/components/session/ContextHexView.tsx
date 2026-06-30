import { useCallback, useMemo } from 'react';
import { useSessionContext } from '@/contexts/SessionContext';
import { HexView } from '@/components/HexView';
import { RegisterContext, SymbolResolver, ViewMode } from '@/lib/hexUtils';
import { resolveSymbol } from '@/lib/symbolUtils';

interface ContextHexViewProps {
  memoryViewId?: string;
  initialAddress?: bigint;
  initialViewMode?: ViewMode;
}

export const ContextHexView = ({ memoryViewId, initialAddress, initialViewMode }: ContextHexViewProps) => {
  const sessionData = useSessionContext();
  const context = sessionData?.session?.current_event?.context;

  // Extract registers from thread context
  const registers: RegisterContext = useMemo(() => {
    if (!context) return {};

    if (context.arch === 'X64') {
      return {
        rax: context.rax,
        rbx: context.rbx,
        rcx: context.rcx,
        rdx: context.rdx,
        rsi: context.rsi,
        rdi: context.rdi,
        rbp: context.rbp,
        rsp: context.rsp,
        rip: context.rip,
        r8: context.r8,
        r9: context.r9,
        r10: context.r10,
        r11: context.r11,
        r12: context.r12,
        r13: context.r13,
        r14: context.r14,
        r15: context.r15,
        eflags: context.eflags,
      };
    } else if (context.arch === 'Arm64') {
      return {
        x0: context.x0, x1: context.x1, x2: context.x2, x3: context.x3,
        x4: context.x4, x5: context.x5, x6: context.x6, x7: context.x7,
        x8: context.x8, x9: context.x9, x10: context.x10, x11: context.x11,
        x12: context.x12, x13: context.x13, x14: context.x14, x15: context.x15,
        x16: context.x16, x17: context.x17, x18: context.x18, x19: context.x19,
        x20: context.x20, x21: context.x21, x22: context.x22, x23: context.x23,
        x24: context.x24, x25: context.x25, x26: context.x26, x27: context.x27,
        x28: context.x28, x29: context.x29, x30: context.x30,
        sp: context.sp,
        pc: context.pc,
        cpsr: context.cpsr,
      };
    }

    return {};
  }, [context]);

  // Create symbol resolver that uses searchSymbols
  const resolveSymbolFn: SymbolResolver = useCallback(async (name: string) => {
    if (!sessionData?.searchSymbols) return null;
    try {
      const result = await resolveSymbol(sessionData.searchSymbols, name);
      return result?.address ?? null;
    } catch {
      return null;
    }
  }, [sessionData?.searchSymbols]);

  // Get session status as string
  const sessionStatus = sessionData?.session?.status;
  const statusString = typeof sessionStatus === 'string' ? sessionStatus : undefined;

  const { setHardwareBreakpoint } = sessionData.breakpointState;
  const { addBookmark } = sessionData.bookmarkState;

  return (
    <HexView
      sessionId={sessionData?.session?.id}
      memoryViewId={memoryViewId}
      sessionStatus={statusString}
      registers={registers}
      resolveSymbol={resolveSymbolFn}
      initialAddress={initialAddress}
      initialViewMode={initialViewMode}
      onSetHardwareBreakpoint={setHardwareBreakpoint}
      onAddBookmark={(address, valueType) => addBookmark({ kind: 'value', address, valueType })}
    />
  );
};
