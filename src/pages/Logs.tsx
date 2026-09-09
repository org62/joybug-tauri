import { useState, useEffect, useMemo, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { VirtualizedList } from "@/components/ui/virtualized-list";
import { Page } from "@/components/ui/page";
import { useHoverPopup } from "@/hooks/useHoverPopup";
import { ExceptionHoverPopup, exceptionFields } from "@/components/ExceptionDetailBlock";
import type { CallStackFrame } from "@/components/CallStackFrameList";
import type { ExceptionDetail } from "@/contexts/SessionContext";
import { Trash2, Filter, ChevronRight, ChevronDown } from "lucide-react";
import { toast } from "sonner";

interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
  /** Decoded record for exception lines: unfoldable / hoverable in the list. */
  exception?: ExceptionDetail;
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

/**
 * One virtual row. The list has a fixed row height, so an unfolded exception
 * entry is flattened into extra rows (its decoded fields, then one row per
 * callstack frame) instead of growing the entry itself. `index` is the
 * entry's position in the backend's append-only log, so it is a stable key
 * across the 2s refetch.
 */
type Row =
  | { kind: "log"; key: string; index: number; log: LogEntry }
  | { kind: "detail"; key: string; label: string; text: string }
  | { kind: "frame"; key: string; frame: CallStackFrame };

/** The decoded-field rows shown above the frames when an entry is unfolded.
 *  Code and chance are omitted: the log line itself already carries them. */
function detailRows(index: number, d: ExceptionDetail): Row[] {
  return exceptionFields(d, false).map(([label, text]) => ({
    kind: "detail" as const, key: `d${index}-${label}`, label, text,
  }));
}

// Level ordering for the "warning and above" style filter. Module-level so the
// filter memo doesn't rebuild it on every 2s poll.
const LEVEL_PRIORITY: Record<string, number> = { debug: 0, info: 1, warning: 2, error: 3 };

// Child rows (decoded fields, callstack frames) share the log row's height and
// sit indented under their entry.
const CHILD_ROW_CLASS =
  "flex items-center gap-2 pl-24 pr-2 border-b border-border/30 h-full font-mono text-xs leading-none bg-muted/20";

export default function Logs() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [levelFilter, setLevelFilter] = useState<string>("all");
  const [searchFilter, setSearchFilter] = useState<string>("");
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const popup = useHoverPopup<ExceptionDetail>(300);

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
      setExpanded(new Set());
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

  const toggleExpanded = useCallback((index: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index); else next.add(index);
      return next;
    });
  }, []);

  // Two stages: filtering re-runs only when the logs or the filters change,
  // so expanding a row doesn't re-scan every entry.
  const filtered = useMemo(() => {
    const selectedLevel = levelFilter.toLowerCase();
    const searchLower = searchFilter.toLowerCase();

    const out: Array<{ log: LogEntry; index: number }> = [];
    logs.forEach((log, index) => {
      const logLevel = log.level.toLowerCase();
      const matchesLevel = levelFilter === "all" ||
        (LEVEL_PRIORITY[logLevel] !== undefined &&
         LEVEL_PRIORITY[selectedLevel] !== undefined &&
         LEVEL_PRIORITY[logLevel] >= LEVEL_PRIORITY[selectedLevel]);
      const matchesSearch = searchFilter === "" ||
        log.message.toLowerCase().includes(searchLower) ||
        log.timestamp.toLowerCase().includes(searchLower);
      if (matchesLevel && matchesSearch) out.push({ log, index });
    });
    return out;
  }, [logs, levelFilter, searchFilter]);

  // Newest first; an unfolded exception entry is followed by its child rows.
  const rows = useMemo(() => {
    const out: Row[] = [];
    for (let i = filtered.length - 1; i >= 0; i--) {
      const { log, index } = filtered[i];
      out.push({ kind: "log", key: `l${index}`, index, log });
      if (log.exception && expanded.has(index)) {
        out.push(...detailRows(index, log.exception));
        log.exception.callstack.forEach((frame) => {
          out.push({ kind: "frame", key: `f${index}-${frame.frame_number}`, frame });
        });
      }
    }
    return out;
  }, [filtered, expanded]);
  const filteredCount = filtered.length;

  const renderRow = (row: Row) => {
    if (row.kind === "detail") {
      return (
        <div data-testid="log-detail-row" className={CHILD_ROW_CLASS}>
          <span className="w-16 shrink-0 text-muted-foreground">{row.label}</span>
          <span className="min-w-0 flex-1 truncate" title={row.text}>{row.text}</span>
        </div>
      );
    }
    if (row.kind === "frame") {
      const { frame } = row;
      const text = frame.symbol_info ?? frame.instruction_pointer;
      return (
        <div data-testid="log-frame-row" className={CHILD_ROW_CLASS}>
          <span className="w-16 shrink-0 text-muted-foreground">#{frame.frame_number}</span>
          <span className="shrink-0 text-muted-foreground tabular-nums">{frame.instruction_pointer}</span>
          <span className="min-w-0 flex-1 truncate" title={text}>{text}</span>
        </div>
      );
    }
    const { log, index } = row;
    const tone = LEVEL_TONE[log.level.toLowerCase()] ?? LEVEL_TONE_DEFAULT;
    const exception = log.exception;
    const isOpen = expanded.has(index);
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
        {exception && (
          // Click unfolds the record + frames inline; resting the cursor shows
          // them in a popup without changing the list.
          <Button
            variant="ghost"
            size="xs"
            data-testid="log-exception-toggle"
            aria-expanded={isOpen}
            className="shrink-0 text-muted-foreground"
            onClick={() => toggleExpanded(index)}
            onMouseEnter={(e) => popup.show(e, exception)}
            onMouseMove={popup.move}
            onMouseLeave={popup.leave}
          >
            {isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            stack ({exception.callstack.length})
          </Button>
        )}
      </div>
    );
  };

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
            Showing {filteredCount} of {logs.length} logs
          </div>
          {logs.length === 0 ? (
            <div className="flex-1 w-full rounded-md border min-h-0 flex items-center justify-center">
              <div className="text-center text-gray-500 dark:text-gray-400 py-8">
                No logs available. Try using the debugger to generate some logs.
              </div>
            </div>
          ) : filteredCount === 0 ? (
            <div className="flex-1 w-full rounded-md border min-h-0 flex items-center justify-center">
              <div className="text-center text-gray-500 dark:text-gray-400 py-8">
                No logs match the current filters.
              </div>
            </div>
          ) : (
            <VirtualizedList
              items={rows}
              rowHeight={LOG_ROW_HEIGHT}
              getItemKey={(row) => row.key}
              className="flex-1 w-full rounded-md border min-h-0"
              renderItem={renderRow}
            />
          )}
        </div>
      </div>
      <ExceptionHoverPopup popup={popup} testId="log-exception-popup" />
    </Page>
  );
}
