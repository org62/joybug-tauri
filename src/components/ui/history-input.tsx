import * as React from "react";
import { createPortal } from "react-dom";
import { ChevronDown } from "lucide-react";
import { Input, type InputProps } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { readInputHistory, subscribeToInputHistory } from "@/lib/inputHistory";
import { cn } from "@/lib/utils";
import {
  usePopoverDismiss,
  computeAnchoredDropdownRect,
  type AnchoredDropdownRect,
} from "@/hooks/usePopoverDismiss";

export interface HistoryInputProps extends InputProps {
  /** Identity of this logical input; the storage key is `input-history:${historyKey}`. */
  historyKey: string;
  /** Always-available values listed after the recalled history (deduped
   *  against it), so the dropdown is useful before anything was submitted. */
  presets?: string[];
}

/**
 * True while any HistoryInput's recall dropdown is open. The shared
 * `DialogContent` consults this on Escape (Radix sees the key on the document
 * capture phase, before the input's own handler) so Escape closes only the
 * dropdown, never the dialog hosting it.
 */
export function isHistoryDropdownOpen(): boolean {
  return document.querySelector('[data-slot="history-dropdown"]') !== null;
}

function mergeRefs<T>(...refs: Array<React.Ref<T> | undefined>): React.RefCallback<T> {
  return (node) => {
    for (const ref of refs) {
      if (!ref) continue;
      if (typeof ref === "function") ref(node);
      else (ref as React.MutableRefObject<T | null>).current = node;
    }
  };
}

/**
 * An `Input` with history recall. Call sites record submitted values with
 * `pushInputHistory(historyKey, value)` from their submit handler (which also
 * covers button-triggered submits); this component only replays them.
 *
 * Navigation follows the dropdown, not the shell: the list renders newest-first
 * top-to-bottom and the highlight moves the way the key points — ArrowDown walks
 * *down* into older entries, ArrowUp walks back up and restores the draft past
 * the newest one. From a closed input either arrow opens the list on the newest
 * value, so a single ArrowUp still recalls the last submission. Escape restores
 * what was being typed, Enter is forwarded to the caller untouched.
 *
 * A dimmed chevron inside the input opens the list by mouse; unlike the arrow
 * keys it only browses — the draft is left alone until a row is chosen. It is
 * rendered only when this key actually has stored history.
 *
 * The wrapper mirrors `Input`'s own box classes (`w-full min-w-0`) and receives
 * the caller's `className` alongside the input, so layout classes (`flex-1`,
 * `w-24`, …) size the outer box exactly as they used to size a bare input while
 * styling classes still reach the input itself.
 */
export const HistoryInput = React.forwardRef<HTMLInputElement, HistoryInputProps>(
  ({ historyKey, presets, className, onChange, onKeyDown, onFocus, ...props }, forwardedRef) => {
    const readItems = (): string[] => {
      const history = readInputHistory(historyKey);
      const extra = (presets ?? []).filter((v) => !history.includes(v));
      return [...history, ...extra];
    };
    const inputRef = React.useRef<HTMLInputElement>(null);
    const wrapperRef = React.useRef<HTMLDivElement>(null);
    const dropdownRef = React.useRef<HTMLDivElement>(null);
    const isControlled = props.value !== undefined;

    // A nav session snapshots the history and the in-progress draft when it
    // opens; `index` is the highlighted row (-1 = draft, nothing highlighted).
    const [open, setOpen] = React.useState(false);
    const [items, setItems] = React.useState<string[]>([]);
    const [index, setIndex] = React.useState(-1);
    const [draft, setDraft] = React.useState("");
    const [rect, setRect] = React.useState<AnchoredDropdownRect | null>(null);
    const [hasHistory, setHasHistory] = React.useState(false);

    // The trigger is an affordance for something to recall, so it tracks whether
    // this key has any. Pushes happen in the caller's submit handler while this
    // input stays mounted, hence the subscription rather than a mount-time read.
    React.useEffect(() => {
      const refresh = () => setHasHistory(readInputHistory(historyKey).length > 0);
      refresh();
      return subscribeToInputHistory((key) => {
        if (key === historyKey) refresh();
      });
    }, [historyKey]);

    const closeNav = React.useCallback(() => {
      setOpen(false);
      setIndex(-1);
      setRect(null);
    }, []);

    // Anchored on the wrapper, not the input: the chevron is a sibling of the
    // input, so an input-anchored dismiss would read a click on it as "outside",
    // close the list, and let the click reopen it — a trigger that never closes.
    usePopoverDismiss(open, closeNav, wrapperRef, dropdownRef);

    const currentValue = () =>
      isControlled ? String(props.value ?? "") : (inputRef.current?.value ?? "");

    // Recalled values flow through the caller's onChange so its state (and any
    // sanitizer) stays authoritative; the uncontrolled case writes the DOM
    // value itself since no re-render will. Contract: the controlled-case event
    // is synthetic and carries only `target.value` — onChange handlers must not
    // touch `currentTarget`, `nativeEvent`, or event methods.
    const fillValue = (value: string) => {
      const node = inputRef.current;
      if (!isControlled && node) {
        node.value = value;
        onChange?.({ target: node } as unknown as React.ChangeEvent<HTMLInputElement>);
      } else {
        onChange?.({ target: { value } } as React.ChangeEvent<HTMLInputElement>);
      }
    };

    const openNav = (): string[] | null => {
      const node = inputRef.current;
      if (!node) return null;
      const history = readItems();
      if (history.length === 0) return null;
      setItems(history);
      setDraft(currentValue());
      setIndex(-1);
      // The gesture originated from the mounted input, so measure it now —
      // no layout effect needed.
      setRect(computeAnchoredDropdownRect(node));
      setOpen(true);
      return history;
    };

    const selectRow = (list: string[], next: number) => {
      setIndex(next);
      fillValue(list[next]);
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (!open) {
          // Either arrow opens on the newest value, so the muscle-memory
          // "ArrowUp recalls my last entry" gesture still lands in one press.
          const list = openNav();
          if (!list) {
            onKeyDown?.(e);
            return;
          }
          selectRow(list, 0);
        } else if (e.key === "ArrowDown") {
          selectRow(items, Math.min(index + 1, items.length - 1));
        } else {
          const next = index - 1;
          if (next < 0) {
            // Above the newest row is the draft the recall interrupted.
            fillValue(draft);
            closeNav();
          } else {
            selectRow(items, next);
          }
        }
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (e.key === "Escape" && open) {
        fillValue(draft);
        closeNav();
        // Consume it: hosts (assemble editor, dialogs) treat Escape as
        // "close"; only an unconsumed Escape should reach them.
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (e.key === "Enter") closeNav();
      onKeyDown?.(e);
    };

    // User typing supersedes the recall session.
    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      if (open) closeNav();
      onChange?.(e);
    };

    const toggleNav = () => {
      if (open) closeNav();
      else openNav();
      inputRef.current?.focus();
    };

    const mergedRef = React.useMemo(() => mergeRefs(inputRef, forwardedRef), [forwardedRef]);

    const showTrigger = (hasHistory || (presets?.length ?? 0) > 0) && !props.disabled;
    // The 20px `inline` size has no room for the standard chevron inset.
    const dense = props.inputSize === "inline";

    return (
      <div
        ref={wrapperRef}
        data-slot="history-input"
        className={cn("relative w-full min-w-0", className)}
      >
        <Input
          ref={mergedRef}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onFocus={(e) => {
            setHasHistory(readInputHistory(historyKey).length > 0);
            onFocus?.(e);
          }}
          className={cn(className, "w-full", showTrigger && (dense ? "pr-5" : "pr-6"))}
          {...props}
        />
        {showTrigger && (
          <button
            type="button"
            // Not a tab stop: it duplicates the arrow keys, which are already
            // available to whoever has the input focused.
            tabIndex={-1}
            data-slot="history-trigger"
            aria-label="Show recent values"
            title="Recent values"
            // Keep focus (and the caret) in the input across the click.
            onMouseDown={(e) => e.preventDefault()}
            onClick={toggleNav}
            className={cn(
              "absolute top-1/2 -translate-y-1/2 text-muted-foreground/50 transition-colors hover:text-foreground",
              dense ? "right-0.5" : "right-1",
            )}
          >
            <ChevronDown className={dense ? "size-3" : "size-3.5"} />
          </button>
        )}
        {open && rect &&
          createPortal(
            <div
              ref={dropdownRef}
              data-slot="history-dropdown"
              className="fixed z-[60] pointer-events-auto"
              style={{ left: rect.left, top: rect.top, width: rect.width }}
              // Keep host dismiss layers (e.g. a Radix dialog's outside-pointer
              // handling) from treating clicks in the portal as "outside".
              onPointerDown={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <ScrollArea
                className="rounded-md border bg-popover shadow-md"
                style={{ maxHeight: rect.maxHeight }}
              >
                {items.map((item, i) => (
                  <Button
                    key={item}
                    size="xs"
                    variant="ghost"
                    className={`flex h-auto w-full justify-start rounded-none px-2 py-1 text-left font-mono font-normal ${
                      i === index ? "bg-accent" : ""
                    }`}
                    onClick={() => {
                      fillValue(item);
                      closeNav();
                      inputRef.current?.focus();
                    }}
                  >
                    <span className="truncate">{item}</span>
                  </Button>
                ))}
              </ScrollArea>
            </div>,
            document.body,
          )}
      </div>
    );
  },
);
HistoryInput.displayName = "HistoryInput";
