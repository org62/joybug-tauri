import { useCallback } from "react";
import { DockPanel, PanelToolbar, PanelBody } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DereferenceEntry } from "@/lib/hexUtils";
import { RegisterDereferenceDisplay } from "@/components/DereferenceDisplay";
import { cn, CHANGED_VALUE_CLASS } from "@/lib/utils";

interface Serializablex64ThreadContext {
  arch: "X64";
  rax: string; rbx: string; rcx: string; rdx: string;
  rsi: string; rdi: string; rbp: string; rsp: string;
  rip: string;
  r8: string; r9: string; r10: string; r11: string;
  r12: string; r13: string; r14: string; r15: string;
  eflags: string;
  xmm0: string; xmm1: string; xmm2: string; xmm3: string;
  xmm4: string; xmm5: string; xmm6: string; xmm7: string;
  xmm8: string; xmm9: string; xmm10: string; xmm11: string;
  xmm12: string; xmm13: string; xmm14: string; xmm15: string;
  dr0: string; dr1: string; dr2: string; dr3: string;
  dr6: string; dr7: string;
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
  // NEON/SIMD vector registers V0-V31 (128-bit, "0x"+32 hex digits) + FP control/status.
  v0: string; v1: string; v2: string; v3: string; v4: string; v5: string; v6: string; v7: string;
  v8: string; v9: string; v10: string; v11: string; v12: string; v13: string; v14: string; v15: string;
  v16: string; v17: string; v18: string; v19: string; v20: string; v21: string; v22: string; v23: string;
  v24: string; v25: string; v26: string; v27: string; v28: string; v29: string; v30: string; v31: string;
  fpcr: string; fpsr: string;
}

export type SerializableThreadContext =
  | Serializablex64ThreadContext
  | SerializableArm64ThreadContext;

/** How to render the 128-bit XMM registers. */
export type XmmFormat = "hex" | "f32" | "f64";

interface RegisterViewProps {
  context: SerializableThreadContext;
  getDereferenceForAddress?: (address: string) => DereferenceEntry | undefined;
  changedRegisters?: Set<string>;
  onRegisterEdit?: (field: string, hexValue: string) => void;
  // x64-only view options (persisted by the parent). Ignored on ARM64.
  showXmm?: boolean;
  showDr?: boolean;
  xmmFormat?: XmmFormat;
  onToggleXmm?: () => void;
  onToggleDr?: () => void;
  onXmmFormatChange?: (format: XmmFormat) => void;
}

interface RegisterPairProps {
  name: string;
  field: string;
  value: string;
  dereferenceEntry?: DereferenceEntry;
  showDereference?: boolean;
  isChanged?: boolean;
  nameWidthClass: string;
  onRegisterEdit?: (field: string, hexValue: string) => void;
}

const RegisterPair = ({ name, field, value, dereferenceEntry, showDereference = true, isChanged, nameWidthClass, onRegisterEdit }: RegisterPairProps) => {
  const handleEditClick = useCallback(() => {
    onRegisterEdit?.(field, value);
  }, [onRegisterEdit, field, value]);

  // font-mono sits on the row, not just the value: the name and the dereference
  // text are data too, and mixing a proportional name column with a mono value
  // column leaves the values starting at a different x on every row.
  return (
    // text-data carries the shared data density (13px/18px) — its line-height
    // alone sets the row height, so there is no vertical padding.
    <div className="flex items-center font-mono text-data px-1 hover:bg-muted/30 rounded-sm min-w-0 overflow-hidden">
      <span className={cn("font-semibold text-muted-foreground shrink-0", nameWidthClass)}>{name}</span>
      <span
        data-changed={isChanged || undefined}
        className={cn(
          "ml-1 shrink-0",
          isChanged && CHANGED_VALUE_CLASS,
          onRegisterEdit && "cursor-pointer hover:underline"
        )}
        onClick={handleEditClick}
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

export const X64_XMM_REGISTERS: RegisterDef[] = Array.from({ length: 16 }, (_, i) => ({
  name: `XMM${i}`,
  field: `xmm${i}`,
  showDereference: false,
}));

export const X64_DEBUG_REGISTERS: RegisterDef[] = [
  { name: "DR0", field: "dr0" }, { name: "DR1", field: "dr1" },
  { name: "DR2", field: "dr2" }, { name: "DR3", field: "dr3" },
  { name: "DR6", field: "dr6", showDereference: false },
  { name: "DR7", field: "dr7", showDereference: false },
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

/** ARM64 NEON/SIMD vector registers V0-V31 (128-bit each), the ARM analogue of
 *  x64's XMM. Rendered under the "NEON" toggle. */
export const ARM64_NEON_REGISTERS: RegisterDef[] = Array.from({ length: 32 }, (_, i) => ({
  name: `V${i}`,
  field: `v${i}`,
  showDereference: false,
}));

function formatFloat(v: number): string {
  if (Number.isNaN(v)) return "NaN";
  if (!Number.isFinite(v)) return v > 0 ? "+Inf" : "-Inf";
  if (v === 0) return Object.is(v, -0) ? "-0" : "0";
  // Trim to 7 significant digits, then drop trailing-zero noise.
  return parseFloat(v.toPrecision(7)).toString();
}

/**
 * Decode a 128-bit XMM hex string ("0x" + 32 digits, high 64 bits then low)
 * into its f32 (×4) or f64 (×2) lanes.
 */
function xmmLanes(hex: string, format: "f32" | "f64"): string[] {
  const s = hex.replace(/^0x/i, "").padStart(32, "0").slice(-32);
  const dv = new DataView(new ArrayBuffer(16));
  dv.setBigUint64(0, BigInt("0x" + s.slice(16)), true); // low 64 bits
  dv.setBigUint64(8, BigInt("0x" + s.slice(0, 16)), true); // high 64 bits
  if (format === "f32") {
    return [0, 1, 2, 3].map((i) => formatFloat(dv.getFloat32(i * 4, true)));
  }
  return [0, 1].map((i) => formatFloat(dv.getFloat64(i * 8, true)));
}

/** Small muted section divider inside the register list, with optional right-aligned control. */
const SectionLabel = ({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) => (
  <div className="mt-1.5 mb-0.5 px-1 border-t border-border pt-1 flex items-center justify-between gap-2">
    <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground select-none">
      {children}
    </span>
    {right}
  </div>
);

/** 128-bit vector-register section (XMM on x64, NEON on ARM64): section header
 *  with the lane-format selector, then one row per register. */
function VectorRegisterSection({
  label,
  defs,
  registers,
  format,
  onFormatChange,
  isChanged,
}: {
  label: string;
  defs: RegisterDef[];
  registers: Record<string, string>;
  format: XmmFormat;
  onFormatChange?: (format: XmmFormat) => void;
  isChanged: (field: string) => boolean;
}) {
  return (
    <>
      <SectionLabel
        right={
          <Select value={format} onValueChange={(v) => onFormatChange?.(v as XmmFormat)}>
            <SelectTrigger size="xs" className="w-20" aria-label={`${label} format`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="hex">Hex</SelectItem>
              <SelectItem value="f32">f32</SelectItem>
              <SelectItem value="f64">f64</SelectItem>
            </SelectContent>
          </Select>
        }
      >
        {label}
      </SectionLabel>
      {defs.map(({ name, field }) => (
        <RegisterPair
          key={field}
          name={name}
          field={field}
          value={format === "hex" ? registers[field] : xmmLanes(registers[field], format).join("  ")}
          showDereference={false}
          isChanged={isChanged(field)}
          nameWidthClass="w-12"
        />
      ))}
    </>
  );
}

function renderRegisterRows(
  registers: Record<string, string>,
  defs: RegisterDef[],
  getDeref: (value: string) => DereferenceEntry | undefined,
  isChanged: (field: string) => boolean,
  nameWidthClass: string,
  onRegisterEdit?: (field: string, hexValue: string) => void,
) {
  return defs.map(({ name, field, showDereference }) => {
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
        nameWidthClass={nameWidthClass}
        onRegisterEdit={onRegisterEdit}
      />
    );
  });
}

export function RegisterView({
  context,
  getDereferenceForAddress,
  changedRegisters,
  onRegisterEdit,
  showXmm = false,
  showDr = false,
  xmmFormat = "hex",
  onToggleXmm,
  onToggleDr,
  onXmmFormatChange,
}: RegisterViewProps) {
  const getDeref = (value: string) => getDereferenceForAddress?.(value);
  const isChanged = (field: string) => changedRegisters?.has(field) ?? false;

  if (context.arch === "Arm64") {
    const registers = context as unknown as Record<string, string>;
    // NEON (V0-V31) is the ARM64 analogue of XMM; it reuses the same
    // show/format state (showXmm/xmmFormat) as x64's vector view.
    return (
      <DockPanel>
        <PanelToolbar>
          <Button
            variant={showXmm ? "default" : "outline"}
            size="xs"
            onClick={onToggleXmm}
            title="Show NEON (SIMD) registers V0–V31"
          >
            NEON
          </Button>
        </PanelToolbar>
        <PanelBody>
          {/* w-0 min-w-full: zero the intrinsic max-content width so long
              deref chains can't widen the panel (same idiom as GroupedItemList) */}
          <div className="p-1 flex flex-col w-0 min-w-full">
            {renderRegisterRows(registers, ARM64_REGISTERS, getDeref, isChanged, "w-8", onRegisterEdit)}
            {showXmm && (
              <VectorRegisterSection
                label="NEON"
                defs={ARM64_NEON_REGISTERS}
                registers={registers}
                format={xmmFormat}
                onFormatChange={onXmmFormatChange}
                isChanged={isChanged}
              />
            )}
          </div>
        </PanelBody>
      </DockPanel>
    );
  }

  if (context.arch === "X64") {
    const registers = context as unknown as Record<string, string>;
    return (
      <DockPanel>
        <PanelToolbar>
          <Button
            variant={showXmm ? "default" : "outline"}
            size="xs"
            onClick={onToggleXmm}
            title="Show XMM (SSE) registers"
          >
            XMM
          </Button>
          <Button
            variant={showDr ? "default" : "outline"}
            size="xs"
            onClick={onToggleDr}
            title="Show debug registers (DR0–DR7)"
          >
            DR
          </Button>
        </PanelToolbar>
        <PanelBody>
          {/* w-0 min-w-full: zero the intrinsic max-content width so long
              deref chains can't widen the panel (same idiom as GroupedItemList) */}
          <div className="p-1 flex flex-col w-0 min-w-full">
            {renderRegisterRows(registers, X64_REGISTERS, getDeref, isChanged, "w-8", onRegisterEdit)}
            {showXmm && (
              <VectorRegisterSection
                label="XMM"
                defs={X64_XMM_REGISTERS}
                registers={registers}
                format={xmmFormat}
                onFormatChange={onXmmFormatChange}
                isChanged={isChanged}
              />
            )}
            {showDr && (
              <>
                <SectionLabel>Debug</SectionLabel>
                {renderRegisterRows(registers, X64_DEBUG_REGISTERS, getDeref, isChanged, "w-12")}
              </>
            )}
          </div>
        </PanelBody>
      </DockPanel>
    );
  }

  return (
    <DockPanel>
      <div className="p-4 text-center text-muted-foreground">
        <p>Unknown or unsupported register context format.</p>
      </div>
    </DockPanel>
  );
}
