import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Trash2, RefreshCw, Filter } from "lucide-react";
import { toast } from "sonner";

interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
}

export default function Logs() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [levelFilter, setLevelFilter] = useState<string>("all");
  const [searchFilter, setSearchFilter] = useState<string>("");

  const fetchLogs = async () => {
    try {
      setIsLoading(true);
      const fetchedLogs = await invoke<LogEntry[]>("get_logs");
      setLogs(fetchedLogs);
    } catch (error) {
      console.error("Failed to fetch logs:", error);
      toast.error(`Failed to fetch logs: ${error}`);
    } finally {
      setIsLoading(false);
    }
  };

  const clearLogs = async () => {
    try {
      await invoke("clear_logs");
      setLogs([]);
      toast.success("Logs cleared successfully");
    } catch (error) {
      console.error("Failed to clear logs:", error);
      toast.error(`Failed to clear logs: ${error}`);
    }
  };

  useEffect(() => {
    fetchLogs();
    // Set up an interval to fetch logs every 2 seconds
    const interval = setInterval(fetchLogs, 2000);
    return () => clearInterval(interval);
  }, []);

  const getLogIcon = (level: string) => {
    switch (level.toLowerCase()) {
      case 'success':
        return '✓';
      case 'error':
        return '✗';
      case 'info':
        return 'ℹ';
      default:
        return '•';
    }
  };

  const getLogColor = (level: string) => {
    switch (level.toLowerCase()) {
      case 'success':
        return 'text-green-600 dark:text-green-400';
      case 'error':
        return 'text-red-600 dark:text-red-400';
      case 'info':
        return 'text-blue-600 dark:text-blue-400';
      default:
        return 'text-gray-600 dark:text-gray-400';
    }
  };

  const filteredLogs = logs.filter(log => {
    const matchesLevel = levelFilter === "all" || log.level.toLowerCase() === levelFilter.toLowerCase();
    const matchesSearch = searchFilter === "" || 
      log.message.toLowerCase().includes(searchFilter.toLowerCase()) ||
      log.timestamp.toLowerCase().includes(searchFilter.toLowerCase());
    return matchesLevel && matchesSearch;
  });

  return (
    <div className="container mx-auto p-6">
      <Card>
        <CardHeader>
          <div className="flex justify-between items-center">
            <CardTitle className="text-2xl">Application Logs</CardTitle>
            <div className="flex gap-2">
              <Button
                onClick={fetchLogs}
                disabled={isLoading}
                variant="outline"
                size="sm"
                className="flex items-center gap-2"
              >
                <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
                Refresh
              </Button>
              <Button
                onClick={clearLogs}
                variant="outline"
                size="sm"
                className="flex items-center gap-2"
              >
                <Trash2 className="h-4 w-4" />
                Clear
              </Button>
            </div>
          </div>
          <div className="flex gap-4 mt-4">
            <div className="flex items-center gap-2">
              <Filter className="h-4 w-4" />
              <span className="text-sm font-medium">Filters:</span>
            </div>
            <Select value={levelFilter} onValueChange={setLevelFilter}>
              <SelectTrigger className="w-32">
                <SelectValue placeholder="Level" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Levels</SelectItem>
                <SelectItem value="success">Success</SelectItem>
                <SelectItem value="error">Error</SelectItem>
                <SelectItem value="info">Info</SelectItem>
              </SelectContent>
            </Select>
            <Input
              placeholder="Search logs..."
              value={searchFilter}
              onChange={(e) => setSearchFilter(e.target.value)}
              className="w-64"
            />
          </div>
        </CardHeader>
        <CardContent>
          <div className="mb-4 text-sm text-gray-500 dark:text-gray-400">
            Showing {filteredLogs.length} of {logs.length} logs
          </div>
          <div className="space-y-4">
            {logs.length === 0 ? (
              <div className="text-center text-gray-500 dark:text-gray-400 py-8">
                No logs available. Try using the debugger to generate some logs.
              </div>
            ) : filteredLogs.length === 0 ? (
              <div className="text-center text-gray-500 dark:text-gray-400 py-8">
                No logs match the current filters.
              </div>
            ) : (
              filteredLogs.map((log, index) => (
                <div key={index} className="p-4 bg-gray-100 dark:bg-neutral-800 rounded-lg">
                  <div className="text-sm text-gray-500 dark:text-neutral-400">
                    {log.timestamp}
                  </div>
                  <div className={getLogColor(log.level)}>
                    {log.message.match(/^[✓✗ℹ•]/) ? log.message : `${getLogIcon(log.level)} ${log.message}`}
                  </div>
                </div>
              ))
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
} 