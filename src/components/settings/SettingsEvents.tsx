import { useCallback, useMemo, useState } from "react";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, Trash2 } from "lucide-react";
import { useDebugSettings, EVENT_ITEMS, type EventSettingItem, type ExceptionRule } from "@/hooks/useDebugSettings";
import { usePlatform } from "@/hooks/usePlatform";
import { POSIX_SIGNALS, exceptionCodeSignal, signalExceptionCode } from "@/lib/exceptionNames";

interface SettingsEventsProps {
  searchQuery: string;
}

/** Renders an "Events and Exceptions" category block matching the keybinding section style. */
export function SettingsEvents({ searchQuery }: SettingsEventsProps) {
  const { settings, toggle, updateExceptionRules } = useDebugSettings();
  const signals = usePlatform().os === "linux";

  const matchesSearch = useCallback((item: EventSettingItem): boolean => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (
      item.label.toLowerCase().includes(q) ||
      "events".includes(q) ||
      "exceptions".includes(q) ||
      item.keywords.some(kw => kw.includes(q))
    );
  }, [searchQuery]);

  const showExceptionRules = useMemo(() => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return "exception".includes(q) || "rules".includes(q) || "pass".includes(q) || "handled".includes(q) || "signals".includes(q);
  }, [searchQuery]);

  const visibleItems = useMemo(() => EVENT_ITEMS.filter(matchesSearch), [matchesSearch]);

  const handleAddRule = useCallback(() => {
    // Pre-populate code from the last exception the debugger hit
    const lastCode = parseInt(localStorage.getItem("joybug_last_exception_code") ?? "0", 10);
    const newRule: ExceptionRule = {
      code: lastCode,
      first_chance: "stop",
      second_chance: "stop",
    };
    updateExceptionRules([...settings.exception_rules, newRule]);
  }, [settings.exception_rules, updateExceptionRules]);

  const handleRemoveRule = useCallback((index: number) => {
    const next = settings.exception_rules.filter((_, i) => i !== index);
    updateExceptionRules(next);
  }, [settings.exception_rules, updateExceptionRules]);

  const handleUpdateRule = useCallback((index: number, field: keyof ExceptionRule, value: string | number) => {
    const next = settings.exception_rules.map((rule, i) => {
      if (i !== index) return rule;
      return { ...rule, [field]: value };
    });
    updateExceptionRules(next);
  }, [settings.exception_rules, updateExceptionRules]);

  if (visibleItems.length === 0 && !showExceptionRules) return null;

  return (
    <div>
      <h3 className="text-sm font-semibold text-muted-foreground mb-2">Events and Exceptions</h3>
      {visibleItems.length > 0 && (
        <div>
          {visibleItems.map((item) => (
            <div
              key={item.key}
              className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-muted/50 border-b border-border/50 last:border-b-0"
            >
              <div className="text-sm font-medium">{item.label}</div>
              <Switch
                checked={settings[item.key]}
                onCheckedChange={() => toggle(item.key)}
              />
            </div>
          ))}
        </div>
      )}

      {showExceptionRules && (
        <div className="mt-4">
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-sm font-semibold text-muted-foreground">Exception Rules</h4>
            <Button variant="outline" size="xs" onClick={handleAddRule}>
              <Plus className="h-3 w-3 mr-1" />
              Add
            </Button>
          </div>
          {settings.exception_rules.length === 0 ? (
            <p className="text-xs text-muted-foreground px-2" data-testid="exception-rules-empty">
              No exception rules configured. All exceptions will stop the debugger.
              {signals && " Signals that are not faults (SIGUSR1, SIGINT, SIGTERM, …) reach the target unseen: add a rule for a signal to stop on it."}
            </p>
          ) : (
            <div className="space-y-1.5">
              {settings.exception_rules.map((rule, index) => (
                <ExceptionRuleRow
                  key={index}
                  rule={rule}
                  index={index}
                  signals={signals}
                  onUpdate={handleUpdateRule}
                  onRemove={handleRemoveRule}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** An exception code as the code field shows it: `0xC0000005`. */
const hexCode = (code: number) => `0x${code.toString(16).toUpperCase()}`;

function ExceptionRuleRow({
  rule,
  index,
  signals,
  onUpdate,
  onRemove,
}: {
  rule: ExceptionRule;
  index: number;
  /** The target OS has POSIX signals: offer them by name. */
  signals: boolean;
  onUpdate: (index: number, field: keyof ExceptionRule, value: string | number) => void;
  onRemove: (index: number) => void;
}) {
  const [codeText, setCodeText] = useState(() => (rule.code ? hexCode(rule.code) : ""));

  const handleCodeBlur = useCallback(() => {
    const clean = codeText.trim().replace(/^0x/i, "");
    const parsed = parseInt(clean, 16);
    if (!isNaN(parsed)) {
      onUpdate(index, "code", parsed);
      setCodeText(hexCode(parsed));
    }
  }, [codeText, index, onUpdate]);

  // A signal is a rule like any other, under the code the backend reports it
  // as; picking one by name just fills that code in.
  const signal = exceptionCodeSignal(rule.code);
  const handleSignalChange = useCallback((value: string) => {
    const code = signalExceptionCode(Number(value));
    onUpdate(index, "code", code);
    setCodeText(hexCode(code));
  }, [index, onUpdate]);

  return (
    <div className="rounded border border-border/50 px-2 py-1.5 space-y-2" data-testid="exception-rule">
      <div className="flex items-center gap-1.5">
        {signals && (
          <Select value={signal !== null ? String(signal) : ""} onValueChange={handleSignalChange}>
            <SelectTrigger size="xs" className="w-32 shrink-0" data-testid="exception-rule-signal">
              <SelectValue placeholder="Signal…" />
            </SelectTrigger>
            <SelectContent>
              {POSIX_SIGNALS.map((s) => (
                <SelectItem key={s.signo} value={String(s.signo)}>{s.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Input
          inputSize="xs"
          className="font-mono flex-1"
          placeholder="0xC0000005"
          data-testid="exception-rule-code"
          value={codeText}
          onChange={(e) => setCodeText(e.target.value)}
          onBlur={handleCodeBlur}
        />
        <Button variant="ghost" size="icon-xs" className="shrink-0" onClick={() => onRemove(index)}>
          <Trash2 className="text-muted-foreground" />
        </Button>
      </div>
      <div className="flex items-center gap-1.5 pr-[34px]">
        <div className="flex items-center gap-1 flex-1">
          <span className="text-xs text-muted-foreground shrink-0">1st</span>
          <Select value={rule.first_chance} onValueChange={(v) => onUpdate(index, "first_chance", v)}>
            <SelectTrigger size="xs" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="stop">Stop</SelectItem>
              <SelectItem value="pass">Pass</SelectItem>
              <SelectItem value="handled">Handled</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-1 flex-1">
          <span className="text-xs text-muted-foreground shrink-0">2nd</span>
          <Select value={rule.second_chance} onValueChange={(v) => onUpdate(index, "second_chance", v)}>
            <SelectTrigger size="xs" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="stop">Stop</SelectItem>
              <SelectItem value="pass">Pass</SelectItem>
              <SelectItem value="handled">Handled</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
  );
}
