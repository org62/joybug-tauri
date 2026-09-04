import { parseTenetTrace } from "./tenetParser";

/** Subset of the `emulation-result` payload the trace builders need. */
export interface TraceResultLike {
  mode: string;
  trace_text: string | null;
  basic_blocks: string[];
  instruction_info: { address: string; symbol: string | null; mnemonic: string; op_str: string }[];
}

/** One executed instruction of an emulation run, with what it changed. */
export interface TraceStep {
  index: number;
  /** Uppercase `0X…` — the same key space as breakpoint / executed-row sets. */
  address: string;
  symbol: string | null;
  mnemonic: string;
  opStr: string;
  /** `rax=0x1, rcx=0x2` — registers that differ from the previous step
   *  (`(initial)` on the first step of an instruction trace). */
  changes: string;
  /** `R 0x… [hex], W 0x… [hex]` memory accesses of this step. */
  memory: string;
  /** Full register state before the step (`k: v` per line); empty for block traces. */
  registers: string;
  /** Set by `buildCallSteps`: how control reached this step. */
  kind?: "call" | "ret";
}

/** Everything an emulation run did at one address. */
export interface RowTrace {
  /** The most recent pass over this address. */
  last: TraceStep;
  count: number;
  /** Every pass, in execution order. */
  steps: TraceStep[];
}

function pcKeyOf(registers: Record<string, string>): string {
  return "rip" in registers ? "rip" : "eip" in registers ? "eip" : "pc" in registers ? "pc" : Object.keys(registers)[0] || "rip";
}

/**
 * Flatten an emulation result into ordered steps. Instruction traces carry
 * per-step register deltas and memory accesses; basic-block results only
 * know the block start addresses.
 */
export function buildTraceSteps(result: TraceResultLike | null): TraceStep[] {
  if (!result) return [];

  const instrMap = new Map<string, TraceResultLike["instruction_info"][number]>();
  for (const info of result.instruction_info) instrMap.set(info.address.toUpperCase(), info);

  if (result.mode === "InstructionTrace" && result.trace_text) {
    const entries = parseTenetTrace(result.trace_text);
    return entries.map((entry, i) => {
      const pcKey = pcKeyOf(entry.registers);
      const address = (entry.registers[pcKey] || "").toUpperCase();
      const info = instrMap.get(address);

      let changes = "";
      if (i === 0) {
        changes = "(initial)";
      } else {
        const prev = entries[i - 1];
        const parts: string[] = [];
        for (const [key, value] of Object.entries(entry.registers)) {
          if (key === pcKey) continue;
          if (prev.registers[key] !== value) parts.push(`${key}=${value}`);
        }
        changes = parts.join(", ");
      }

      const memParts: string[] = [];
      for (const m of entry.memoryReads) memParts.push(`R ${m.address} [${m.data}]`);
      for (const m of entry.memoryWrites) memParts.push(`W ${m.address} [${m.data}]`);

      return {
        index: i,
        address,
        symbol: info?.symbol ?? null,
        mnemonic: info?.mnemonic ?? "",
        opStr: info?.op_str ?? "",
        changes,
        memory: memParts.join(", "),
        registers: Object.entries(entry.registers).map(([k, v]) => `${k}: ${v}`).join("\n"),
      };
    });
  }

  if (result.mode === "BasicBlock" && result.basic_blocks.length > 0) {
    return result.basic_blocks.map((addr, i) => {
      const address = addr.toUpperCase();
      const info = instrMap.get(address);
      return {
        index: i,
        address,
        symbol: info?.symbol ?? null,
        mnemonic: info?.mnemonic ?? "",
        opStr: info?.op_str ?? "",
        changes: "",
        memory: "",
        registers: "",
      };
    });
  }

  return [];
}

const CALL_MNEMONICS = new Set(["call", "bl", "blr", "blx"]);
const RET_MNEMONICS = new Set(["ret", "retn", "retf", "iret", "iretq"]);

/**
 * Reduce an instruction trace to the places control *arrived* via a call or a
 * return: the step after each call/ret instruction, tagged with how it got
 * there. Block traces carry no mnemonics, so they yield nothing.
 */
export function buildCallSteps(steps: TraceStep[]): TraceStep[] {
  const out: TraceStep[] = [];
  for (let i = 1; i < steps.length; i++) {
    const prev = steps[i - 1].mnemonic.toLowerCase();
    const kind = CALL_MNEMONICS.has(prev) ? "call" : RET_MNEMONICS.has(prev) ? "ret" : null;
    if (kind) out.push({ ...steps[i], kind });
  }
  return out;
}

/** Group steps by address so a disassembly row can look up what ran there. */
export function indexTraceByAddress(steps: TraceStep[]): Map<string, RowTrace> {
  const byAddress = new Map<string, RowTrace>();
  for (const step of steps) {
    const existing = byAddress.get(step.address);
    if (existing) {
      existing.last = step;
      existing.count += 1;
      existing.steps.push(step);
    } else {
      byAddress.set(step.address, { last: step, count: 1, steps: [step] });
    }
  }
  return byAddress;
}

/** How a step names its location: its symbol, else its lowercased address. */
export function stepLabel(step: TraceStep): string {
  return step.symbol ?? step.address.toLowerCase();
}

/** `changes` and `memory` of one step, joined for a single-line annotation. */
export function formatStepValues(step: TraceStep, separator = ", "): string {
  return [step.changes, step.memory].filter(Boolean).join(separator);
}

/** What a step's detail panel shows below the memory block: the full register
 *  state, or — for block traces, which carry none — whatever names the step. */
export function stepDetailText(step: TraceStep): string {
  return step.registers || stepLabel(step);
}
