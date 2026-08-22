import { stepDetailText, type TraceStep } from "@/lib/emulationTrace";

/**
 * The "what this step did" block shared by the disassembly row popup and the
 * trace listing's tooltip: the step's memory accesses, then its register state
 * (or, for block traces which carry none, whatever names the step).
 */
export function TraceStepDetails({ step, label }: { step: TraceStep; label?: string }) {
  return (
    <>
      {step.memory && (
        <div className="mb-1">
          <div className="text-muted-foreground mb-0.5">Memory at step #{step.index}:</div>
          <pre className="whitespace-pre-wrap">{step.memory.split(", ").join("\n")}</pre>
        </div>
      )}
      <div className="text-muted-foreground mb-1">{label ?? `Registers at step #${step.index}:`}</div>
      <pre className="whitespace-pre-wrap">{stepDetailText(step)}</pre>
    </>
  );
}
