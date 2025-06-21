import { useState, useEffect, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, Play, Pause, Square, ChevronRight } from "lucide-react";
import { toast } from "sonner";

interface DebugEvent {
  type: string;
  data: {
    process_id: number;
    thread_id: number;
    image_file_name?: string;
    base_of_image?: string;
    size_of_image?: number;
    start_address?: string;
    exception_code?: number;
    exception_address?: string;
    is_first_chance?: boolean;
    address?: string;
    message?: string;
    dll_name?: string;
    base_of_dll?: string;
    size_of_dll?: number;
    exit_code?: number;
    error?: number;
    event_type?: number;
  };
}

interface DisassemblyInstruction {
  address: string;
  bytes: number[];
  mnemonic: string;
  operands?: string;
}

interface DisassemblyResult {
  instructions: DisassemblyInstruction[];
  start_address: string;
  end_address: string;
}

export default function Session() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  
  const [currentEvent, setCurrentEvent] = useState<DebugEvent | null>(null);
  const [disassembly, setDisassembly] = useState<DisassemblyResult | null>(null);
  const [isWaitingForEvent, setIsWaitingForEvent] = useState(false);
  const [isContinuing, setIsContinuing] = useState(false);
  const [isDisassembling, setIsDisassembling] = useState(false);
  const [serverUrl] = useState("http://localhost:9000"); // Get from config or props
  const [currentProcessId, setCurrentProcessId] = useState<number>(0);
  const [currentThreadId, setCurrentThreadId] = useState<number>(0);

  const getEventTypeAndDetails = (event: DebugEvent) => {
    const data = event.data;
    
    switch (event.type) {
      case "ProcessCreated":
        return {
          type: "Process Created",
          details: `PID: ${data.process_id}, TID: ${data.thread_id}, Name: ${data.image_file_name || 'Unknown'}`,
          processId: data.process_id,
          threadId: data.thread_id,
        };
      case "ThreadCreated":
        return {
          type: "Thread Created",
          details: `PID: ${data.process_id}, TID: ${data.thread_id}, Start: ${data.start_address}`,
          processId: data.process_id,
          threadId: data.thread_id,
        };
      case "DllLoaded":
        return {
          type: "DLL Loaded",
          details: `PID: ${data.process_id}, TID: ${data.thread_id}, Module: ${data.dll_name || 'Unknown'}, Base: ${data.base_of_dll}`,
          processId: data.process_id,
          threadId: data.thread_id,
        };
      case "ExceptionOccurred":
        return {
          type: "Exception",
          details: `PID: ${data.process_id}, TID: ${data.thread_id}, Code: 0x${data.exception_code?.toString(16)}, Address: ${data.exception_address}, First Chance: ${data.is_first_chance}`,
          processId: data.process_id,
          threadId: data.thread_id,
          exceptionAddress: data.exception_address,
        };
      case "BreakpointHit":
        return {
          type: "Breakpoint Hit",
          details: `PID: ${data.process_id}, TID: ${data.thread_id}, Address: ${data.address}`,
          processId: data.process_id,
          threadId: data.thread_id,
          exceptionAddress: data.address,
        };
      case "ProcessExited":
        return {
          type: "Process Exited",
          details: `PID: ${data.process_id}, Exit Code: ${data.exit_code}`,
          processId: data.process_id,
          threadId: data.thread_id,
        };
      case "ThreadExited":
        return {
          type: "Thread Exited",
          details: `PID: ${data.process_id}, TID: ${data.thread_id}, Exit Code: ${data.exit_code}`,
          processId: data.process_id,
          threadId: data.thread_id,
        };
      case "OutputDebugString":
        return {
          type: "Debug Output",
          details: `PID: ${data.process_id}, TID: ${data.thread_id}, Message: ${data.message}`,
          processId: data.process_id,
          threadId: data.thread_id,
        };
      default:
        return {
          type: event.type || "Unknown",
          details: `PID: ${data.process_id}, TID: ${data.thread_id}`,
          processId: data.process_id,
          threadId: data.thread_id,
        };
    }
  };

    const waitForEvent = async () => {
    if (!sessionId) return;
    
    console.log("waitForEvent called - stack trace:", new Error().stack);
    
    try {
      setIsWaitingForEvent(true);
      console.log("Making wait_for_event request to server");
      const event = await invoke<DebugEvent>("wait_for_event", {
        sessionId,
        serverUrl,
      });
      console.log("Received event from server:", event);
      
      setCurrentEvent(event);
      const eventInfo = getEventTypeAndDetails(event);
      setCurrentProcessId(eventInfo.processId);
      setCurrentThreadId(eventInfo.threadId);
      
      // If this is an exception event, disassemble at the exception address
      if (event.type === "ExceptionOccurred" || event.type === "BreakpointHit") {
        const address = event.data.exception_address || event.data.address;
        if (address) {
          await disassembleAtAddress(address, eventInfo.processId);
        }
      }
      
      toast.success(`Debug event received: ${eventInfo.type}`);
      
      // For now, stop automatic continuation to debug the basic flow
      console.log(`Event received: ${eventInfo.type}, PID=${eventInfo.processId}, TID=${eventInfo.threadId}`);
      console.log("Use the 'Next' button to continue execution");
    } catch (error) {
      console.error("Failed to wait for event:", error);
      toast.error(`Failed to wait for event: ${error}`);
      
      // If it's a timeout error, we might want to retry
      if (error && typeof error === 'string' && error.includes('timeout')) {
        toast.info("Retrying to wait for debug event...");
        setTimeout(() => {
          waitForEvent();
        }, 1000);
      }
    } finally {
      setIsWaitingForEvent(false);
    }
  };

    const continueExecution = async (
    decision: "continue" | "handled" | "unhandled" = "continue", 
    processId?: number, 
    threadId?: number
  ) => {
    if (!sessionId) {
      console.error("Cannot continue: no session ID");
      return;
    }
    
    const pidToUse = processId ?? currentProcessId;
    const tidToUse = threadId ?? currentThreadId;
    
    if (pidToUse === 0) {
      console.error("Cannot continue: invalid process ID");
      toast.error("Cannot continue: invalid process ID");
      return;
    }
    
    try {
      setIsContinuing(true);
      console.log(`Continuing execution: PID=${pidToUse}, TID=${tidToUse}, decision=${decision}`);
      await invoke("continue_event", {
        sessionId,
        serverUrl,
        processId: pidToUse,
        threadId: tidToUse,
        decision,
      });
      
      console.log("Continue request sent successfully");
      toast.success("Execution continued");
    } catch (error) {
      console.error("Failed to continue execution:", error);
      toast.error(`Failed to continue execution: ${error}`);
    } finally {
      setIsContinuing(false);
    }
  };

  const disassembleAtAddress = async (address: string, processId: number) => {
    if (!sessionId) return;
    
    try {
      setIsDisassembling(true);
      const result = await invoke<DisassemblyResult>("disassemble", {
        sessionId,
        serverUrl,
        processId,
        address,
        size: 256, // Disassemble 256 bytes
        maxInstructions: 20, // Show up to 20 instructions
      });
      
      setDisassembly(result);
      toast.success(`Disassembled ${result.instructions.length} instructions`);
    } catch (error) {
      console.error("Failed to disassemble:", error);
      toast.error(`Failed to disassemble: ${error}`);
    } finally {
      setIsDisassembling(false);
    }
  };

  // Prevent multiple simultaneous wait calls (use ref to survive React Strict Mode)
  const hasInitialWaitRef = useRef(false);
  
  // Initial event wait when component mounts
  useEffect(() => {
    if (sessionId && !hasInitialWaitRef.current) {
      console.log("useEffect: First time calling waitForEvent for sessionId:", sessionId);
      hasInitialWaitRef.current = true;
      waitForEvent();
    }
  }, [sessionId]);

  if (!sessionId) {
    return (
      <div className="container mx-auto px-4 py-8">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-red-600">Session Not Found</h1>
          <p className="text-muted-foreground mt-2">Invalid session ID</p>
          <Button onClick={() => navigate("/")} className="mt-4">
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Debugger
          </Button>
        </div>
      </div>
    );
  }

  const eventInfo = currentEvent ? getEventTypeAndDetails(currentEvent) : null;

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button variant="outline" onClick={() => navigate("/debugger")}>
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back
            </Button>
            <div>
              <h1 className="text-3xl font-bold">Debug Session</h1>
              <p className="text-muted-foreground">Session ID: {sessionId}</p>
            </div>
          </div>
          
          <div className="flex items-center gap-2">
            <Button
              onClick={() => waitForEvent()}
              disabled={isWaitingForEvent || isContinuing}
              variant="outline"
            >
              <Pause className="h-4 w-4 mr-2" />
              {isWaitingForEvent ? "Waiting..." : "Wait for Event"}
            </Button>
                         <Button
               onClick={async () => {
                 await continueExecution();
                 waitForEvent();
               }}
               disabled={!currentEvent || isContinuing || isWaitingForEvent}
               variant="default"
             >
               <ChevronRight className="h-4 w-4 mr-2" />
               {isContinuing ? "Continuing..." : "Next"}
             </Button>
          </div>
        </div>

        {/* Current Event */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Current Debug Event</CardTitle>
              {eventInfo && (
                <Badge variant="secondary">
                  {eventInfo.type}
                </Badge>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {eventInfo ? (
              <div className="space-y-2">
                <div className="text-sm">
                  <strong>Details:</strong> {eventInfo.details}
                </div>
                {eventInfo.processId > 0 && (
                  <div className="text-sm">
                    <strong>Process ID:</strong> {eventInfo.processId}
                  </div>
                )}
                {eventInfo.threadId > 0 && (
                  <div className="text-sm">
                    <strong>Thread ID:</strong> {eventInfo.threadId}
                  </div>
                )}
              </div>
            ) : (
              <div className="text-muted-foreground">
                {isWaitingForEvent ? (
                  <div className="flex items-center gap-2">
                    <div className="animate-spin h-4 w-4 border-2 border-current border-t-transparent rounded-full" />
                    Waiting for debug event...
                  </div>
                ) : (
                  "No debug event received yet"
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Disassembly */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>Disassembly</CardTitle>
                {disassembly && (
                  <CardDescription>
                    {disassembly.start_address} - {disassembly.end_address} ({disassembly.instructions.length} instructions)
                  </CardDescription>
                )}
              </div>
              {currentEvent && currentProcessId > 0 && (
                <Button
                  onClick={() => {
                    if (eventInfo?.exceptionAddress) {
                      disassembleAtAddress(eventInfo.exceptionAddress, currentProcessId);
                    }
                  }}
                  disabled={isDisassembling || !eventInfo?.exceptionAddress}
                  variant="outline"
                  size="sm"
                >
                  {isDisassembling ? "Disassembling..." : "Refresh Disassembly"}
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {disassembly ? (
              <div className="font-mono text-sm space-y-1 bg-gray-50 dark:bg-gray-900 p-4 rounded-md overflow-x-auto">
                {disassembly.instructions.map((instruction, index) => (
                  <div key={index} className="flex items-center gap-4 hover:bg-gray-100 dark:hover:bg-gray-800 px-2 py-1 rounded">
                    <div className="text-blue-600 dark:text-blue-400 w-24 flex-shrink-0">
                      {instruction.address}
                    </div>
                    <div className="text-gray-500 w-32 flex-shrink-0">
                      {instruction.bytes.map(b => b.toString(16).padStart(2, '0')).join(' ')}
                    </div>
                    <div className="text-green-600 dark:text-green-400 w-16 flex-shrink-0">
                      {instruction.mnemonic}
                    </div>
                    <div className="text-gray-700 dark:text-gray-300">
                      {instruction.operands || ''}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-muted-foreground text-center py-8">
                {isDisassembling ? (
                  <div className="flex items-center justify-center gap-2">
                    <div className="animate-spin h-4 w-4 border-2 border-current border-t-transparent rounded-full" />
                    Disassembling...
                  </div>
                ) : (
                  "No disassembly available. Trigger an exception event to see disassembly."
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
} 