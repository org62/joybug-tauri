import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
  sessionId: string;
  address: number;
}

export function AssemblyView({ sessionId, address }: AssemblyViewProps) {
  const [instructions, setInstructions] = useState<Instruction[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchDisassembly = async () => {
      if (!sessionId || !address) return;

      setIsLoading(true);
      setError(null);

      try {
        const result = await invoke<Instruction[]>("get_disassembly", {
          sessionId,
          address,
          count: 30, // Show 30 instructions
        });
        setInstructions(result);
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
  }, [sessionId, address]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Disassembly</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <div className="animate-spin h-6 w-6 border-2 border-current border-t-transparent rounded-full" />
            <span className="ml-2">Loading disassembly...</span>
          </div>
        ) : error ? (
          <div className="text-center py-8 text-red-500">
            <p>Error loading disassembly:</p>
            <p className="text-sm mt-1 font-mono">{error}</p>
          </div>
        ) : (
          <ScrollArea className="h-72 w-full">
            <div className="font-mono text-sm bg-gray-50 dark:bg-gray-900 p-4 rounded-md">
              <pre>
                {instructions.map((inst, index) => (
                  <div key={index} className="flex items-center">
                    <span className="text-muted-foreground w-64">{inst.symbol}</span>
                    <span className="w-40 text-gray-500">{inst.bytes.padEnd(24)}</span>
                    <span className="w-24 text-blue-500">{inst.mnemonic}</span>
                    <span>{inst.op_str}</span>
                  </div>
                ))}
              </pre>
            </div>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
} 