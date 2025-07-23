import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { ScrollArea } from "./ui/scroll-area";

interface Instruction {
  address: string;
  symbol: string;
  bytes: string;
  mnemonic: string;
  op_str: string;
}

interface AssemblyViewProps {
  sessionId?: string;
  address?: number;
}

export function AssemblyView({ sessionId, address }: AssemblyViewProps) {
  const [instructions, setInstructions] = useState<Instruction[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastFetchedAddress, setLastFetchedAddress] = useState<number | null>(null);

  useEffect(() => {
    const fetchDisassembly = async () => {
      if (!sessionId || !address || address === lastFetchedAddress) return;

      setIsLoading(true);
      setError(null);

      try {
        const result = await invoke<Instruction[]>("get_disassembly", {
          sessionId,
          address,
          count: 0x10
        });
        setInstructions(result);
        setLastFetchedAddress(address);
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : String(err);
        console.error("Failed to fetch disassembly:", errorMessage);
        toast.error(`Failed to fetch disassembly: ${errorMessage}`);
        setError(errorMessage);
      } finally {
        setIsLoading(false);
      }
    };

    fetchDisassembly();
  }, [sessionId, address, lastFetchedAddress]);

  if (!sessionId || !address) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
        <div className="text-center">
          <p className="text-base font-medium">No disassembly available</p>
          <p className="text-sm mt-1">Address information will appear here when debugging</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full text-red-500">
        <div className="text-center">
          <p>Error loading disassembly:</p>
          <p className="text-sm mt-1 font-mono">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <ScrollArea className="h-full w-full">
      <div className="font-mono text-sm bg-gray-50 dark:bg-gray-900 p-4">
        <pre>
          {instructions.map((inst, index) => (
            <div key={index} className="flex items-center hover:bg-muted/50 px-1 py-0.5 rounded-sm">
              <span className="text-muted-foreground w-64 shrink-0">{inst.symbol}</span>
              <span className="w-40 text-gray-500 shrink-0">{inst.bytes.padEnd(24)}</span>
              <span className="w-24 text-blue-500 shrink-0">{inst.mnemonic}</span>
              <span>{inst.op_str}</span>
            </div>
          ))}
        </pre>
      </div>
    </ScrollArea>
  );
} 