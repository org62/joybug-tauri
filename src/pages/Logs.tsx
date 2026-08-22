import { useState, useEffect, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { VirtualizedList } from "@/components/ui/virtualized-list";
import { Page } from "@/components/ui/page";
import { Trash2, Filter } from "lucide-react";
import { toast } from "sonner";

interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
}

// Dense single-line rows: the list is virtualized with a fixed row height.
const LOG_ROW_HEIGHT = 22;

// Level column text + message tone. No icons: the level word and its color
// carry the severity; DEBUG is dimmed so it recedes. Module-level so a
// virtualized row doesn't allocate a fresh object per render.
const LEVEL_TONE: Record<string, { label: string; message: string }> = {
  debug: { label: 'text-muted-foreground/60', message: 'text-muted-foreground/70' },
  info: { label: 'text-muted-foreground', message: 'text-foreground' },
  warning: { label: 'text-syn-state font-medium', message: 'text-syn-state' },
  error: { label: 'text-destructive font-medium', message: 'text-destructive' },
};
const LEVEL_TONE_DEFAULT = { label: 'text-muted-foreground', message: 'text-muted-foreground' };

// Timestamps are "YYYY-MM-DD HH:MM:SS"; the date is noise in a live log, so
// show only the time (full stamp in the tooltip, and still searchable).
const shortTime = (timestamp: string) => {
  const i = timestamp.indexOf(' ');
  return i >= 0 ? timestamp.slice(i + 1) : timestamp;
};

export default function Logs() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [levelFilter, setLevelFilter] = useState<string>("all");
  const [searchFilter, setSearchFilter] = useState<string>("");

  const fetchLogs = async () => {
    try {
      const fetchedLogs = await invoke<LogEntry[]>("get_logs");
      setLogs(fetchedLogs);
    } catch (error) {
      console.error("Failed to fetch logs:", error);
      toast.error(`Failed to fetch logs: ${error}`);
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

  const reversedFilteredLogs = useMemo(() => {
    const levelPriority: Record<string, number> = {
      'debug': 0,
      'info': 1,
      'warning': 2,
      'error': 3
    };
    const selectedLevel = levelFilter.toLowerCase();
    const searchLower = searchFilter.toLowerCase();

    const filtered = logs.filter(log => {
      const logLevel = log.level.toLowerCase();
      const matchesLevel = levelFilter === "all" ||
        (levelPriority[logLevel] !== undefined &&
         levelPriority[selectedLevel] !== undefined &&
         levelPriority[logLevel] >= levelPriority[selectedLevel]);
      const matchesSearch = searchFilter === "" ||
        log.message.toLowerCase().includes(searchLower) ||
        log.timestamp.toLowerCase().includes(searchLower);
      return matchesLevel && matchesSearch;
    });

    return { filtered, reversed: filtered.slice().reverse() };
  }, [logs, levelFilter, searchFilter]);

  const filteredLogs = reversedFilteredLogs.filtered;

  return (
    <Page scroll={false} container={false} className="p-4">
      <div className="flex-1 flex flex-col min-h-0">
        <div className="flex-shrink-0 mb-3">
          <div className="flex justify-between items-center">
            <h1 className="text-2xl font-bold">Application Logs</h1>
            <div className="flex items-center gap-4">
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
                  <SelectItem value="debug">Debug</SelectItem>
                  <SelectItem value="info">Info</SelectItem>
                  <SelectItem value="warning">Warning</SelectItem>
                  <SelectItem value="error">Error</SelectItem>
                </SelectContent>
              </Select>
              <Input
                placeholder="Search logs..."
                value={searchFilter}
                onChange={(e) => setSearchFilter(e.target.value)}
                className="w-64"
              />
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
        </div>
        <div className="flex-1 flex flex-col min-h-0">
          <div className="mb-2 text-xs text-muted-foreground flex-shrink-0">
            Showing {filteredLogs.length} of {logs.length} logs
          </div>
          {logs.length === 0 ? (
            <div className="flex-1 w-full rounded-md border min-h-0 flex items-center justify-center">
              <div className="text-center text-gray-500 dark:text-gray-400 py-8">
                No logs available. Try using the debugger to generate some logs.
              </div>
            </div>
          ) : filteredLogs.length === 0 ? (
            <div className="flex-1 w-full rounded-md border min-h-0 flex items-center justify-center">
              <div className="text-center text-gray-500 dark:text-gray-400 py-8">
                No logs match the current filters.
              </div>
            </div>
          ) : (
            <VirtualizedList
              items={reversedFilteredLogs.reversed}
              rowHeight={LOG_ROW_HEIGHT}
              className="flex-1 w-full rounded-md border min-h-0"
              renderItem={(log) => {
                const tone = LEVEL_TONE[log.level.toLowerCase()] ?? LEVEL_TONE_DEFAULT;
                return (
                  <div
                    data-testid="log-row"
                    data-level={log.level.toLowerCase()}
                    className="flex items-center gap-2 px-2 border-b border-border/50 hover:bg-gray-50 dark:hover:bg-gray-900 h-full font-mono text-xs leading-none"
                  >
                    <span className="text-muted-foreground shrink-0 tabular-nums" title={log.timestamp}>
                      {shortTime(log.timestamp)}
                    </span>
                    <span className={`w-16 shrink-0 uppercase ${tone.label}`}>{log.level}</span>
                    <span className={`min-w-0 flex-1 truncate ${tone.message}`} title={log.message}>
                      {log.message}
                    </span>
                  </div>
                );
              }}
            />
          )}
        </div>
      </div>
    </Page>
  );
}