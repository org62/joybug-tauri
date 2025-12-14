import { ScrollArea } from "@/components/ui/scroll-area";
import { DereferenceEntry } from "@/lib/hexUtils";
import { RegisterDereferenceDisplay } from "@/components/DereferenceDisplay";

interface Serializablex64ThreadContext {
  arch: "X64";
  rax: string; rbx: string; rcx: string; rdx: string;
  rsi: string; rdi: string; rbp: string; rsp: string;
  rip: string;
  r8: string; r9: string; r10: string; r11: string;
  r12: string; r13: string; r14: string; r15: string;
  eflags: string;
}

interface SerializableArm64ThreadContext {
  arch: "Arm64";
  x0: string; x1: string; x2: string; x3: string;
  x4: string; x5: string; x6: string; x7: string;
  x8: string; x9: string; x10: string; x11: string;
  x12: string; x13: string; x14: string; x15: string;
  x16: string; x17: string; x18: string; x19: string;
  x20: string; x21: string; x22: string; x23: string;
  x24: string; x25: string; x26: string; x27: string;
  x28: string; x29: string; x30: string;
  sp: string; pc: string; cpsr: string;
}

export type SerializableThreadContext =
  | Serializablex64ThreadContext
  | SerializableArm64ThreadContext;

interface RegisterViewProps {
  context: SerializableThreadContext;
  getDereferenceForAddress?: (address: string) => DereferenceEntry | undefined;
}

interface RegisterPairProps {
  name: string;
  value: string;
  dereferenceEntry?: DereferenceEntry;
  showDereference?: boolean;
}

const RegisterPair = ({ name, value, dereferenceEntry, showDereference = true }: RegisterPairProps) => {
  return (
    <div className="flex items-center py-0.5 px-1 hover:bg-muted/50 rounded-sm text-xs min-w-0">
      <span className="w-8 font-semibold text-muted-foreground shrink-0">{name}</span>
      <span className="font-mono ml-1 shrink-0">{value}</span>
      {showDereference && (
        <span className="ml-1 min-w-0 truncate">
          <RegisterDereferenceDisplay entry={dereferenceEntry} maxItems={6} />
        </span>
      )}
    </div>
  );
};

export function RegisterView({ context, getDereferenceForAddress }: RegisterViewProps) {
  // Helper to get dereference entry for a register value
  const getDeref = (value: string) => getDereferenceForAddress?.(value);

  if (context.arch === "X64") {
    const registers = context;

    return (
      <ScrollArea className="h-full w-full">
        <div className="p-1 flex flex-col gap-0.5">
          <RegisterPair name="RAX" value={registers.rax} dereferenceEntry={getDeref(registers.rax)} />
          <RegisterPair name="RBX" value={registers.rbx} dereferenceEntry={getDeref(registers.rbx)} />
          <RegisterPair name="RCX" value={registers.rcx} dereferenceEntry={getDeref(registers.rcx)} />
          <RegisterPair name="RDX" value={registers.rdx} dereferenceEntry={getDeref(registers.rdx)} />
          <RegisterPair name="RSI" value={registers.rsi} dereferenceEntry={getDeref(registers.rsi)} />
          <RegisterPair name="RDI" value={registers.rdi} dereferenceEntry={getDeref(registers.rdi)} />
          <RegisterPair name="RBP" value={registers.rbp} dereferenceEntry={getDeref(registers.rbp)} />
          <RegisterPair name="RSP" value={registers.rsp} dereferenceEntry={getDeref(registers.rsp)} />
          <RegisterPair name="RIP" value={registers.rip} dereferenceEntry={getDeref(registers.rip)} />
          <RegisterPair name="R8" value={registers.r8} dereferenceEntry={getDeref(registers.r8)} />
          <RegisterPair name="R9" value={registers.r9} dereferenceEntry={getDeref(registers.r9)} />
          <RegisterPair name="R10" value={registers.r10} dereferenceEntry={getDeref(registers.r10)} />
          <RegisterPair name="R11" value={registers.r11} dereferenceEntry={getDeref(registers.r11)} />
          <RegisterPair name="R12" value={registers.r12} dereferenceEntry={getDeref(registers.r12)} />
          <RegisterPair name="R13" value={registers.r13} dereferenceEntry={getDeref(registers.r13)} />
          <RegisterPair name="R14" value={registers.r14} dereferenceEntry={getDeref(registers.r14)} />
          <RegisterPair name="R15" value={registers.r15} dereferenceEntry={getDeref(registers.r15)} />
          <RegisterPair name="EFL" value={registers.eflags} showDereference={false} />
        </div>
      </ScrollArea>
    );
  }
  
  if (context.arch === "Arm64") {
    const registers = context;

    return (
      <ScrollArea className="h-full w-full">
        <div className="p-1 flex flex-col gap-0.5">
          <RegisterPair name="X0" value={registers.x0} dereferenceEntry={getDeref(registers.x0)} />
          <RegisterPair name="X1" value={registers.x1} dereferenceEntry={getDeref(registers.x1)} />
          <RegisterPair name="X2" value={registers.x2} dereferenceEntry={getDeref(registers.x2)} />
          <RegisterPair name="X3" value={registers.x3} dereferenceEntry={getDeref(registers.x3)} />
          <RegisterPair name="X4" value={registers.x4} dereferenceEntry={getDeref(registers.x4)} />
          <RegisterPair name="X5" value={registers.x5} dereferenceEntry={getDeref(registers.x5)} />
          <RegisterPair name="X6" value={registers.x6} dereferenceEntry={getDeref(registers.x6)} />
          <RegisterPair name="X7" value={registers.x7} dereferenceEntry={getDeref(registers.x7)} />
          <RegisterPair name="X8" value={registers.x8} dereferenceEntry={getDeref(registers.x8)} />
          <RegisterPair name="X9" value={registers.x9} dereferenceEntry={getDeref(registers.x9)} />
          <RegisterPair name="X10" value={registers.x10} dereferenceEntry={getDeref(registers.x10)} />
          <RegisterPair name="X11" value={registers.x11} dereferenceEntry={getDeref(registers.x11)} />
          <RegisterPair name="X12" value={registers.x12} dereferenceEntry={getDeref(registers.x12)} />
          <RegisterPair name="X13" value={registers.x13} dereferenceEntry={getDeref(registers.x13)} />
          <RegisterPair name="X14" value={registers.x14} dereferenceEntry={getDeref(registers.x14)} />
          <RegisterPair name="X15" value={registers.x15} dereferenceEntry={getDeref(registers.x15)} />
          <RegisterPair name="X16" value={registers.x16} dereferenceEntry={getDeref(registers.x16)} />
          <RegisterPair name="X17" value={registers.x17} dereferenceEntry={getDeref(registers.x17)} />
          <RegisterPair name="X18" value={registers.x18} dereferenceEntry={getDeref(registers.x18)} />
          <RegisterPair name="X19" value={registers.x19} dereferenceEntry={getDeref(registers.x19)} />
          <RegisterPair name="X20" value={registers.x20} dereferenceEntry={getDeref(registers.x20)} />
          <RegisterPair name="X21" value={registers.x21} dereferenceEntry={getDeref(registers.x21)} />
          <RegisterPair name="X22" value={registers.x22} dereferenceEntry={getDeref(registers.x22)} />
          <RegisterPair name="X23" value={registers.x23} dereferenceEntry={getDeref(registers.x23)} />
          <RegisterPair name="X24" value={registers.x24} dereferenceEntry={getDeref(registers.x24)} />
          <RegisterPair name="X25" value={registers.x25} dereferenceEntry={getDeref(registers.x25)} />
          <RegisterPair name="X26" value={registers.x26} dereferenceEntry={getDeref(registers.x26)} />
          <RegisterPair name="X27" value={registers.x27} dereferenceEntry={getDeref(registers.x27)} />
          <RegisterPair name="X28" value={registers.x28} dereferenceEntry={getDeref(registers.x28)} />
          <RegisterPair name="FP" value={registers.x29} dereferenceEntry={getDeref(registers.x29)} />
          <RegisterPair name="LR" value={registers.x30} dereferenceEntry={getDeref(registers.x30)} />
          <RegisterPair name="SP" value={registers.sp} dereferenceEntry={getDeref(registers.sp)} />
          <RegisterPair name="PC" value={registers.pc} dereferenceEntry={getDeref(registers.pc)} />
          <RegisterPair name="CPSR" value={registers.cpsr} showDereference={false} />
        </div>
      </ScrollArea>
    );
  }

  return (
    <ScrollArea className="h-full w-full">
      <div className="p-4 text-center text-muted-foreground">
        <p>Unknown or unsupported register context format.</p>
      </div>
    </ScrollArea>
  );
} 