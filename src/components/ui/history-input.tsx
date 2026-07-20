import * as React from "react";
import { createPortal } from "react-dom";
import { Input, type InputProps } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { readInputHistory } from "@/lib/inputHistory";
import {
  usePopoverDismiss,
  computeAnchoredDropdownRect,
  type AnchoredDropdownRect,
} from "@/hooks/usePopoverDismiss";

export interface HistoryInputProps extends InputProps {
  /** Identity of this logical input; the storage key is `input-history:${historyKey}`. */
  historyKey: string;
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
 * An `Input` with shell-style history recall. Call sites record submitted
 * values with `pushInputHistory(historyKey, value)` from their submit handler
 * (which also covers button-triggered submits); this component only replays
 * them: ArrowUp/ArrowDown cycles recent values and shows a dropdown, Escape
 * restores what was being typed, Enter is forwarded to the caller untouched.
 * Renders no wrapper element, so layout classes on the input keep working.
 */
export const HistoryInput = React.forwardRef<HTMLInputElement, HistoryInputProps>(
  ({ historyKey, onChange, onKeyDown, ...props }, forwardedRef) => {
    const inputRef = React.useRef<HTMLInputElement>(null);
    const dropdownRef = React.useRef<HTMLDivElement>(null);
    const isControlled = props.value !== undefined;

    // A nav session snapshots the history and the in-progress draft when the
    // first arrow key opens it; `index` is -1 while browsing (draft shown).
    const [open, setOpen] = React.useState(false);
    const [items, setItems] = React.useState<string[]>([]);
    const [index, setIndex] = React.useState(-1);
    const [draft, setDraft] = React.useState("");
    const [rect, setRect] = React.useState<AnchoredDropdownRect | null>(null);

    const closeNav = React.useCallback(() => {
      setOpen(false);
      setIndex(-1);
      setRect(null);
    }, []);

    usePopoverDismiss(open, closeNav, inputRef, dropdownRef);

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
      const history = readInputHistory(historyKey);
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

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "ArrowUp") {
        const list = open ? items : openNav();
        if (!list) {
          onKeyDown?.(e);
          return;
        }
        const next = Math.min(index + 1, list.length - 1);
        setIndex(next);
        fillValue(list[next]);
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (e.key === "ArrowDown") {
        if (open) {
          const next = index - 1;
          if (next < 0) {
            fillValue(draft);
            closeNav();
          } else {
            setIndex(next);
            fillValue(items[next]);
          }
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        // Idle ArrowDown: open in browse mode (draft untouched) as the
        // discoverable "show me recent values" gesture.
        if (openNav()) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        onKeyDown?.(e);
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

    const mergedRef = React.useMemo(() => mergeRefs(inputRef, forwardedRef), [forwardedRef]);

    return (
      <>
        <Input
          ref={mergedRef}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          {...props}
        />
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
      </>
    );
  },
);
HistoryInput.displayName = "HistoryInput";
