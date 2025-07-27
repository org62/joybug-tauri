import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { ScrollArea } from "./ui/scroll-area";
import { Cpu } from "lucide-react";

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
  const [error, setError] = useState<string | null>(null);
  const [lastFetchedAddress, setLastFetchedAddress] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    const requestDisassembly = async () => {
      if (!sessionId || !address || address === lastFetchedAddress) return;

      setError(null);
      setIsLoading(true);

      try {
        await invoke("request_disassembly", {
          sessionId,
          address,
          count: 0x10
        });
        setLastFetchedAddress(address);
      } catch (err) {
        let errorMessage: string;
        if (err instanceof Error) {
          errorMessage = err.message;
        } else if (typeof err === 'string') {
          errorMessage = err;
        } else if (err && typeof err === 'object') {
          // Handle Tauri error objects which might have message property
          errorMessage = (err as any).message || JSON.stringify(err);
        } else {
          errorMessage = String(err);
        }
        console.error("Failed to request disassembly:", err);
        toast.error(`Failed to request disassembly: ${errorMessage}`);
        setError(errorMessage);
        setIsLoading(false);
      }
    };

    requestDisassembly();
  }, [sessionId, address, lastFetchedAddress]);

  useEffect(() => {
    if (!sessionId) return;

    // Listen for disassembly results
    const unlistenDisassembly = listen<{session_id: string, address: number, instructions: Instruction[]}>(
      "disassembly-updated",
      (event) => {
        if (event.payload.session_id === sessionId && event.payload.address === address) {
          setInstructions(event.payload.instructions);
          setIsLoading(false);
          setError(null);
        }
      }
    );

    // Listen for disassembly errors
    const unlistenError = listen<{session_id: string, address: number, error: string}>(
      "disassembly-error", 
      (event) => {
        if (event.payload.session_id === sessionId && event.payload.address === address) {
          setError(event.payload.error);
          setIsLoading(false);
          toast.error(`Disassembly failed: ${event.payload.error}`);
        }
      }
    );

    return () => {
      unlistenDisassembly.then(unlisten => unlisten());
      unlistenError.then(unlisten => unlisten());
    };
  }, [sessionId, address]);

  if (!sessionId || !address) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
        <div className="text-center">
          <Cpu className="h-12 w-12 mx-auto mb-4 opacity-50" />
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

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        <div className="text-center">
          <Cpu className="h-8 w-8 mx-auto mb-2 animate-pulse" />
          <p>Loading disassembly...</p>
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