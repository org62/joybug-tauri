import { useSessionContext } from '@/contexts/SessionContext';
import { AssemblyView } from '@/components/AssemblyView';

export const ContextAssemblyView = () => {
  const sessionData = useSessionContext();
  const currentEvent = sessionData?.session?.current_event;
  
  return <AssemblyView sessionId={sessionData?.session?.id} address={currentEvent?.address} />;
}; 