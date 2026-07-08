import { useCallback } from "react";
import { DockPanel, PanelBody } from "@/components/ui/panel";
import { DereferenceEntry } from "@/lib/hexUtils";
import { RegisterDereferenceDisplay } from "@/components/DereferenceDisplay";
import { cn } from "@/lib/utils";

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
  changedRegisters?: Set<string>;
  onRegisterEdit?: (field: string, hexValue: string) => void;
}

interface RegisterPairProps {
  name: string;
  field: string;
  value: string;
  dereferenceEntry?: DereferenceEntry;
  showDereference?: boolean;
  isChanged?: boolean;
  onRegisterEdit?: (field: string, hexValue: string) => void;
}

const RegisterPair = ({ name, field, value, dereferenceEntry, showDereference = true, isChanged, onRegisterEdit }: RegisterPairProps) => {
  const handleDoubleClick = useCallback(() => {
    onRegisterEdit?.(field, value);
  }, [onRegisterEdit, field, value]);

  return (
    <div className="flex items-center py-0.5 px-1 hover:bg-muted/50 rounded-sm text-xs min-w-0">
      <span className="w-8 font-semibold text-muted-foreground shrink-0">{name}</span>
      <span
        className={cn(
          "font-mono ml-1 shrink-0",
          isChanged && "text-red-400",
          onRegisterEdit && "cursor-pointer hover:underline"
        )}
        onDoubleClick={handleDoubleClick}
      >
        {value}
      </span>
      {showDereference && (
        <span className="ml-1 min-w-0 truncate">
          <RegisterDereferenceDisplay entry={dereferenceEntry} maxItems={6} />
        </span>
      )}
    </div>
  );
};

export interface RegisterDef {
  name: string;
  field: string;
  showDereference?: boolean;
}

export const X64_REGISTERS: RegisterDef[] = [
  { name: "RAX", field: "rax" }, { name: "RBX", field: "rbx" },
  { name: "RCX", field: "rcx" }, { name: "RDX", field: "rdx" },
  { name: "RSI", field: "rsi" }, { name: "RDI", field: "rdi" },
  { name: "RBP", field: "rbp" }, { name: "RSP", field: "rsp" },
  { name: "RIP", field: "rip" },
  { name: "R8", field: "r8" }, { name: "R9", field: "r9" },
  { name: "R10", field: "r10" }, { name: "R11", field: "r11" },
  { name: "R12", field: "r12" }, { name: "R13", field: "r13" },
  { name: "R14", field: "r14" }, { name: "R15", field: "r15" },
  { name: "EFL", field: "eflags", showDereference: false },
];

export const ARM64_REGISTERS: RegisterDef[] = [
  { name: "X0", field: "x0" }, { name: "X1", field: "x1" },
  { name: "X2", field: "x2" }, { name: "X3", field: "x3" },
  { name: "X4", field: "x4" }, { name: "X5", field: "x5" },
  { name: "X6", field: "x6" }, { name: "X7", field: "x7" },
  { name: "X8", field: "x8" }, { name: "X9", field: "x9" },
  { name: "X10", field: "x10" }, { name: "X11", field: "x11" },
  { name: "X12", field: "x12" }, { name: "X13", field: "x13" },
  { name: "X14", field: "x14" }, { name: "X15", field: "x15" },
  { name: "X16", field: "x16" }, { name: "X17", field: "x17" },
  { name: "X18", field: "x18" }, { name: "X19", field: "x19" },
  { name: "X20", field: "x20" }, { name: "X21", field: "x21" },
  { name: "X22", field: "x22" }, { name: "X23", field: "x23" },
  { name: "X24", field: "x24" }, { name: "X25", field: "x25" },
  { name: "X26", field: "x26" }, { name: "X27", field: "x27" },
  { name: "X28", field: "x28" },
  { name: "FP", field: "x29" }, { name: "LR", field: "x30" },
  { name: "SP", field: "sp" }, { name: "PC", field: "pc" },
  { name: "CPSR", field: "cpsr", showDereference: false },
];

function renderRegisterList(
  registers: Record<string, string>,
  defs: RegisterDef[],
  getDeref: (value: string) => DereferenceEntry | undefined,
  isChanged: (field: string) => boolean,
  onRegisterEdit?: (field: string, hexValue: string) => void,
) {
  return (
    <DockPanel>
      <PanelBody>
        <div className="p-1 flex flex-col gap-0.5">
          {defs.map(({ name, field, showDereference }) => {
          const value = registers[field];
          return (
            <RegisterPair
              key={field}
              name={name}
              field={field}
              value={value}
              dereferenceEntry={showDereference !== false ? getDeref(value) : undefined}
              showDereference={showDereference}
              isChanged={isChanged(field)}
              onRegisterEdit={onRegisterEdit}
            />
          );
          })}
        </div>
      </PanelBody>
    </DockPanel>
  );
}

export function RegisterView({ context, getDereferenceForAddress, changedRegisters, onRegisterEdit }: RegisterViewProps) {
  const getDeref = (value: string) => getDereferenceForAddress?.(value);
  const isChanged = (field: string) => changedRegisters?.has(field) ?? false;

  if (context.arch === "X64") {
    return renderRegisterList(context as unknown as Record<string, string>, X64_REGISTERS, getDeref, isChanged, onRegisterEdit);
  }

  if (context.arch === "Arm64") {
    return renderRegisterList(context as unknown as Record<string, string>, ARM64_REGISTERS, getDeref, isChanged, onRegisterEdit);
  }

  return (
    <DockPanel>
      <div className="p-4 text-center text-muted-foreground">
        <p>Unknown or unsupported register context format.</p>
      </div>
    </DockPanel>
  );
}
