import { useSessionContext } from '@/contexts/SessionContext';
import { RegisterView } from '@/components/RegisterView';
import { AlertCircle } from 'lucide-react';

export const ContextRegisterView = () => {
  const sessionData = useSessionContext();
  const currentEvent = sessionData?.session?.current_event;

  if (currentEvent?.context) {
    return <RegisterView context={currentEvent.context} />;
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