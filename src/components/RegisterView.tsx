import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

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
    <div className="flex items-center">
        <span className="w-12 font-semibold text-muted-foreground">{name}</span>
        <span className="font-mono text-sm">{value}</span>
    </div>
);

export function RegisterView({ context }: RegisterViewProps) {
  if (context.arch === "X64") {
    const registers = context;

    return (
      <Card>
        <CardHeader>
          <CardTitle>CPU Registers (x64)</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-x-6 gap-y-2">
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
              <RegisterPair name="EFLAGS" value={registers.eflags} />
          </div>
        </CardContent>
      </Card>
    );
  }
  
  if (context.arch === "Arm64") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>CPU Registers</CardTitle>
        </CardHeader>
        <CardContent>
          <p>Register view for Arm64 is not yet implemented.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>CPU Registers</CardTitle>
      </CardHeader>
      <CardContent>
        <p>Unknown or unsupported register context format.</p>
      </CardContent>
    </Card>
  );
} 