import { useCallback, useMemo } from 'react';
import { useSessionContext } from '@/contexts/SessionContext';
import { AssemblyView } from '@/components/AssemblyView';
import { RegisterContext, SymbolResolver } from '@/lib/hexUtils';
import { SerializableThreadContext } from '@/components/RegisterView';

// Convert thread context to register context for address expression parsing
function contextToRegisters(context: SerializableThreadContext | undefined): RegisterContext {
  if (!context) return {};

  const registers: RegisterContext = {};

  // Check if it's x64 context (has 'rax' property)
  if ('rax' in context) {
    // x64 registers
    registers['rax'] = context.rax;
    registers['rbx'] = context.rbx;
    registers['rcx'] = context.rcx;
    registers['rdx'] = context.rdx;
    registers['rsi'] = context.rsi;
    registers['rdi'] = context.rdi;
    registers['rbp'] = context.rbp;
    registers['rsp'] = context.rsp;
    registers['rip'] = context.rip;
    registers['r8'] = context.r8;
    registers['r9'] = context.r9;
    registers['r10'] = context.r10;
    registers['r11'] = context.r11;
    registers['r12'] = context.r12;
    registers['r13'] = context.r13;
    registers['r14'] = context.r14;
    registers['r15'] = context.r15;
    registers['eflags'] = context.eflags;
  } else if ('x0' in context) {
    // ARM64 registers
    registers['x0'] = context.x0;
    registers['x1'] = context.x1;
    registers['x2'] = context.x2;
    registers['x3'] = context.x3;
    registers['x4'] = context.x4;
    registers['x5'] = context.x5;
    registers['x6'] = context.x6;
    registers['x7'] = context.x7;
    registers['x8'] = context.x8;
    registers['x9'] = context.x9;
    registers['x10'] = context.x10;
    registers['x11'] = context.x11;
    registers['x12'] = context.x12;
    registers['x13'] = context.x13;
    registers['x14'] = context.x14;
    registers['x15'] = context.x15;
    registers['x16'] = context.x16;
    registers['x17'] = context.x17;
    registers['x18'] = context.x18;
    registers['x19'] = context.x19;
    registers['x20'] = context.x20;
    registers['x21'] = context.x21;
    registers['x22'] = context.x22;
    registers['x23'] = context.x23;
    registers['x24'] = context.x24;
    registers['x25'] = context.x25;
    registers['x26'] = context.x26;
    registers['x27'] = context.x27;
    registers['x28'] = context.x28;
    registers['x29'] = context.x29;
    registers['x30'] = context.x30;
    registers['sp'] = context.sp;
    registers['pc'] = context.pc;
    registers['cpsr'] = context.cpsr;
    // Add aliases
    registers['lr'] = context.x30;
    registers['fp'] = context.x29;
  }

  return registers;
}

export const ContextAssemblyView = () => {
  const sessionData = useSessionContext();
  const currentEvent = sessionData?.session?.current_event;

  // Use displayStatus (debounced) to prevent flicker during stepping
  const displayStatus = sessionData?.displayStatus;
  const address = displayStatus === "Paused" ? currentEvent?.address : undefined;

  // Convert thread context to RegisterContext
  const registers = useMemo(() => {
    return contextToRegisters(currentEvent?.context);
  }, [currentEvent?.context]);

  // Create symbol resolver using session's searchSymbols
  const resolveSymbol: SymbolResolver = useCallback(async (name: string): Promise<bigint | null> => {
    if (!sessionData?.searchSymbols) return null;

    try {
      const symbols = await sessionData.searchSymbols(name, 1);
      if (symbols.length > 0) {
        // Parse the VA (virtual address) from the symbol
        const vaStr = symbols[0].va;
        try {
          return BigInt(vaStr);
        } catch {
          return null;
        }
      }
    } catch (e) {
      console.error('Symbol resolution failed:', e);
    }
    return null;
  }, [sessionData?.searchSymbols]);

  const isPaused = displayStatus === 'Paused';

  return (
    <AssemblyView
      sessionId={sessionData?.session?.id}
      isPaused={isPaused}
      address={address}
      registers={registers}
      resolveSymbol={resolveSymbol}
    />
  );
};
