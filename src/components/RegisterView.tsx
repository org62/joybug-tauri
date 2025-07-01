import { ScrollArea } from "@/components/ui/scroll-area";

interface Serializablex64ThreadContext {
  arch: "X64";
  rax: string; rbx: string; rcx: string; rdx: string;
  rsi: string; rdi: string; rbp: string; rsp: string;
  rip: string;
  r8: string; r9: string; r10: string; r11: string;
  r12: string; r13: string; r14: string; r15: string;
  eflags: string;
}

export type SerializableThreadContext =
  | Serializablex64ThreadContext
  | { arch: "Arm64" };

interface RegisterViewProps {
  context: SerializableThreadContext;
}

const RegisterPair = ({ name, value }: { name: string, value: string }) => (
    <div className="flex items-center py-0.5 px-1 hover:bg-muted/50 rounded-sm text-xs">
        <span className="w-8 font-semibold text-muted-foreground min-w-0 shrink-0">{name}</span>
        <span className="font-mono ml-1">{value}</span>
    </div>
);

export function RegisterView({ context }: RegisterViewProps) {
  if (context.arch === "X64") {
    const registers = context;

    return (
      <ScrollArea className="h-full w-full">
        <div className="p-1">
          <div 
            className="gap-0.5"
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))'
            }}
          >
              <RegisterPair name="RAX" value={registers.rax} />
              <RegisterPair name="RBX" value={registers.rbx} />
              <RegisterPair name="RCX" value={registers.rcx} />
              <RegisterPair name="RDX" value={registers.rdx} />
              <RegisterPair name="RSI" value={registers.rsi} />
              <RegisterPair name="RDI" value={registers.rdi} />
              <RegisterPair name="RBP" value={registers.rbp} />
              <RegisterPair name="RSP" value={registers.rsp} />
              <RegisterPair name="RIP" value={registers.rip} />
              <RegisterPair name="R8" value={registers.r8} />
              <RegisterPair name="R9" value={registers.r9} />
              <RegisterPair name="R10" value={registers.r10} />
              <RegisterPair name="R11" value={registers.r11} />
              <RegisterPair name="R12" value={registers.r12} />
              <RegisterPair name="R13" value={registers.r13} />
              <RegisterPair name="R14" value={registers.r14} />
              <RegisterPair name="R15" value={registers.r15} />
              <RegisterPair name="EFL" value={registers.eflags} />
          </div>
        </div>
      </ScrollArea>
    );
  }
  
  if (context.arch === "Arm64") {
    return (
      <ScrollArea className="h-full w-full">
        <div className="p-4 text-center text-muted-foreground">
          <p>Register view for Arm64 is not yet implemented.</p>
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