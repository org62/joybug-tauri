import { useEffect } from 'react';
import { useSessionContext } from '@/contexts/SessionContext';
import { Badge } from '@/components/ui/badge';
import { Layers } from 'lucide-react';

export const ContextModulesView = () => {
  const sessionData = useSessionContext();
  
  // Load modules when component mounts or session changes
  useEffect(() => {
    if (sessionData?.session?.id) {
      sessionData.loadModules();
    }
  }, [sessionData?.session?.id, sessionData?.session?.status, sessionData?.session?.current_event]);

  const formatBytes = (bytes: number) => {
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = bytes;
    let unitIndex = 0;
    
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }
    
    return `${size.toFixed(1)} ${units[unitIndex]}`;
  };

  const getFileName = (fullPath: string) => {
    const parts = fullPath.split(/[\\/]/);
    return parts[parts.length - 1];
  };

  return (
    <div className="h-full overflow-auto">
      {sessionData?.modules && sessionData.modules.length > 0 ? (
        <div className="space-y-1">
          {sessionData.modules.map((module, index) => (
            <div 
              key={index}
              className="flex items-center justify-between px-2 py-1 border-b hover:bg-gray-50 dark:hover:bg-gray-900"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <h3 className="font-medium text-sm truncate">{getFileName(module.name)}</h3>
                  <Badge variant="outline" className="text-xs px-1 py-0 shrink-0">
                    {formatBytes(module.size)}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground mb-1 truncate">
                  Base: <span className="font-mono">{module.base_address}</span>
                </p>
                <p className="text-xs text-muted-foreground truncate">
                  {module.path}
                </p>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
          <div className="text-center">
            <Layers className="h-12 w-12 mx-auto mb-4 opacity-50" />
            <p className="text-base font-medium">No modules loaded yet</p>
            <p className="text-sm mt-1">Modules will appear here during debugging</p>
          </div>
        </div>
      )}
    </div>
  );
}; 