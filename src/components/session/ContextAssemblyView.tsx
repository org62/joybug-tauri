import { useSessionContext } from '@/contexts/SessionContext';
import { AssemblyView } from '@/components/AssemblyView';

export const ContextAssemblyView = () => {
  const sessionData = useSessionContext();
  const currentEvent = sessionData?.session?.current_event;

  const status = sessionData?.session?.status;
  const address = status === "Paused" ? currentEvent?.address : undefined;

  return <AssemblyView sessionId={sessionData?.session?.id} address={address} />;
}; 