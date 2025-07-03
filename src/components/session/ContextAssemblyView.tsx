import { useSessionContext } from '@/contexts/SessionContext';
import { AssemblyView } from '@/components/AssemblyView';
import { AlertCircle } from 'lucide-react';

export const ContextAssemblyView = () => {
  const sessionData = useSessionContext();
  const currentEvent = sessionData?.session?.current_event;
  
  if (currentEvent?.address && sessionData?.session?.id) {
    return <AssemblyView sessionId={sessionData.session.id} address={currentEvent.address} />;
  }
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
        <div className="text-center">
          <AlertCircle className="h-12 w-12 mx-auto mb-4 opacity-50" />
          <p className="text-base font-medium">No disassembly available</p>
          <p className="text-sm mt-1">Address information will appear here when debugging</p>
        </div>
      </div>
    );
}; 