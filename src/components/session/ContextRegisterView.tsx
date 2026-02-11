import { useRef, useEffect, useMemo } from 'react';
import { useSessionContext } from '@/contexts/SessionContext';
import { RegisterView, SerializableThreadContext } from '@/components/RegisterView';
import { useRegisterDereference } from '@/hooks/useRegisterDereference';
import { AlertCircle } from 'lucide-react';

function computeChangedRegisters(
  prev: SerializableThreadContext | undefined,
  current: SerializableThreadContext
): Set<string> {
  if (!prev || prev.arch !== current.arch) return new Set();
  const changed = new Set<string>();
  for (const key of Object.keys(current)) {
    if (key === "arch") continue;
    if ((current as Record<string, string>)[key] !== (prev as Record<string, string>)[key]) {
      changed.add(key);
    }
  }
  return changed;
}

export const ContextRegisterView = () => {
  const sessionData = useSessionContext();
  const currentEvent = sessionData?.session?.current_event;
  const sessionId = sessionData?.session?.id;

  // Use displayStatus (debounced) to prevent flicker during stepping
  const displayStatus = sessionData?.displayStatus;
  const context = displayStatus === "Paused" ? currentEvent?.context : undefined;

  // Fetch dereference data for all registers (use displayStatus to prevent flicker)
  const { getDereferenceForAddress } = useRegisterDereference(context, sessionId, displayStatus);

  // Track previous context to detect changed registers
  const prevContextRef = useRef<SerializableThreadContext | undefined>(undefined);

  const changedRegisters = useMemo(
    () => context ? computeChangedRegisters(prevContextRef.current, context) : new Set<string>(),
    [context]
  );

  // Update ref after render so next render can diff against it; clear when session ends/resumes
  useEffect(() => {
    if (!sessionId || displayStatus !== "Paused") {
      prevContextRef.current = undefined;
    } else if (context) {
      prevContextRef.current = context;
    }
  }, [context, sessionId, displayStatus]);

  if (context) {
    return <RegisterView context={context} getDereferenceForAddress={getDereferenceForAddress} changedRegisters={changedRegisters} />;
  }
  return (
    <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
      <div className="text-center">
        <AlertCircle className="h-12 w-12 mx-auto mb-4 opacity-50" />
        <p className="text-base font-medium">No register data available</p>
        <p className="text-sm mt-1">Register values will appear here when debugging</p>
      </div>
    </div>
  );
};
