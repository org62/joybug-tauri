import { useSessionContext } from '@/contexts/SessionContext';
import { RegisterView } from '@/components/RegisterView';
import { useRegisterDereference } from '@/hooks/useRegisterDereference';
import { AlertCircle } from 'lucide-react';

export const ContextRegisterView = () => {
  const sessionData = useSessionContext();
  const currentEvent = sessionData?.session?.current_event;
  const status = sessionData?.session?.status;
  const sessionId = sessionData?.session?.id;

  const context = status === "Paused" ? currentEvent?.context : undefined;

  // Fetch dereference data for all registers
  const { getDereferenceForAddress } = useRegisterDereference(context, sessionId, status);

  if (context) {
    return <RegisterView context={context} getDereferenceForAddress={getDereferenceForAddress} />;
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