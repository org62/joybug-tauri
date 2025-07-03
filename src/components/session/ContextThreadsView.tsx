import { useEffect } from 'react';
import { useSessionContext } from '@/contexts/SessionContext';
import { Badge } from '@/components/ui/badge';
import { Cpu } from 'lucide-react';

export const ContextThreadsView = () => {
  const sessionData = useSessionContext();
  
  // Load threads when component mounts or session changes
  useEffect(() => {
    if (sessionData?.session?.id) {
      sessionData.loadThreads();
    }
  }, [sessionData?.session?.id, sessionData?.session?.status, sessionData?.session?.current_event]);

  const getThreadStatusColor = (status: string) => {
    switch (status) {
      case "Running":
        return "bg-green-100 text-green-800 border-green-200";
      case "Suspended":
        return "bg-yellow-100 text-yellow-800 border-yellow-200";
      case "Waiting":
        return "bg-blue-100 text-blue-800 border-blue-200";
      case "Terminated":
        return "bg-red-100 text-red-800 border-red-200";
      default:
        return "bg-gray-100 text-gray-800 border-gray-200";
    }
  };

  return (
    <div className="h-full overflow-auto p-4">
      {sessionData?.threads && sessionData.threads.length > 0 ? (
        <div className="space-y-4">
          {sessionData.threads.map((thread, index) => (
            <div 
              key={index}
              className="flex items-center justify-between p-4 border rounded-lg hover:bg-gray-50 dark:hover:bg-gray-900"
            >
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <h3 className="font-semibold">Thread {thread.id}</h3>
                  <Badge 
                    variant="outline" 
                    className={`${getThreadStatusColor(thread.status)} border text-xs`}
                  >
                    {thread.status}
                  </Badge>
                </div>
                <p className="text-sm text-muted-foreground">
                  Start Address: <span className="font-mono">{thread.start_address}</span>
                </p>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
          <div className="text-center">
            <Cpu className="h-12 w-12 mx-auto mb-4 opacity-50" />
            <p className="text-base font-medium">No threads found</p>
            <p className="text-sm mt-1">Threads will appear here as they are created during debugging</p>
          </div>
        </div>
      )}
    </div>
  );
}; 