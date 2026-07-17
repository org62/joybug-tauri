import React, { useState, useCallback, useRef } from "react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
  CommandSubInput,
} from "@/components/ui/command";
import { useCommandPaletteContext } from "@/contexts/CommandPaletteContext";
import { useKeybindingContext } from "@/contexts/KeybindingContext";
import type { ActionId } from "@/lib/keybindings";
import { ChevronRight } from "lucide-react";

export function CommandPalette() {
  const { isOpen, setOpen, commands, subInput, enterSubInput, clearSubInput } = useCommandPaletteContext();
  const { getKeybinding } = useKeybindingContext();
  const [subInputValue, setSubInputValue] = useState("");
  const [flashId, setFlashId] = useState<string | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout>>();

  // Filter out disabled commands
  const enabledCommands = commands.filter((cmd) => cmd.enabled !== false);

  // Group commands by their group field
  const groups = new Map<string, typeof enabledCommands>();
  for (const cmd of enabledCommands) {
    const group = groups.get(cmd.group);
    if (group) {
      group.push(cmd);
    } else {
      groups.set(cmd.group, [cmd]);
    }
  }

  const handleSelect = useCallback(
    (commandId: string) => {
      const cmd = commands.find((c) => c.id === commandId);
      if (!cmd) return;

      if (cmd.subInput) {
        // Enter sub-input mode — dialog stays open
        enterSubInput({
          label: cmd.label,
          placeholder: cmd.subInput.placeholder,
          onSubmit: cmd.subInput.onSubmit,
        });
      } else if (cmd.keepOpen) {
        // Toggle command — flash animation, dialog stays open
        clearTimeout(flashTimerRef.current);
        setFlashId(commandId);
        flashTimerRef.current = setTimeout(() => setFlashId(null), 350);
        cmd.onSelect();
      } else {
        // Normal command — close dialog
        setOpen(false);
        clearSubInput();
        cmd.onSelect();
      }
    },
    [commands, setOpen, enterSubInput, clearSubInput]
  );

  const handleOpenChange = useCallback(
    (open: boolean) => {
      setOpen(open);
      if (!open) {
        setSubInputValue("");
        clearSubInput();
      }
    },
    [setOpen, clearSubInput]
  );

  const handleSubInputKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && subInput) {
        e.preventDefault();
        const value = subInputValue.trim();
        if (value) {
          subInput.onSubmit(value);
          setSubInputValue("");
          clearSubInput();
          setOpen(false);
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setSubInputValue("");
        clearSubInput();
      }
    },
    [subInput, subInputValue, setOpen, clearSubInput]
  );

  const getShortcutDisplay = (cmd: typeof enabledCommands[0]): string => {
    if (cmd.keybindingAction) {
      return getKeybinding(cmd.keybindingAction as ActionId);
    }
    return cmd.shortcutLabel ?? "";
  };

  return (
    // Radix restores focus to whatever was focused before the palette opened.
    // "Go to X" focuses the target panel's input as it closes, so let the
    // command's own focus win; otherwise focus falls to the body, which is
    // where it effectively went before this existed.
    <CommandDialog open={isOpen} onOpenChange={handleOpenChange} onCloseAutoFocus={(e) => e.preventDefault()}>
      {subInput ? (
        <div className="flex flex-col">
          <div className="flex items-center gap-1.5 border-b px-3 py-2 text-xs text-muted-foreground">
            <span>Commands</span>
            <ChevronRight className="size-3" />
            <span className="text-foreground">{subInput.label}</span>
          </div>
          <CommandSubInput
            placeholder={subInput.placeholder}
            value={subInputValue}
            onChange={(e) => setSubInputValue(e.target.value)}
            onKeyDown={handleSubInputKeyDown}
            autoFocus
          />
          <div className="px-3 py-2 text-xs text-muted-foreground">
            <kbd className="rounded border px-1 py-0.5 text-[10px]">Esc</kbd>
            <span className="ml-1.5">to go back</span>
          </div>
        </div>
      ) : (
        <>
          <CommandInput placeholder="Type a command or search..." />
          <CommandList>
            <CommandEmpty>No results found.</CommandEmpty>
            {Array.from(groups.entries()).map(([groupName, cmds]) => (
              <CommandGroup key={groupName} heading={groupName}>
                {cmds.map((cmd) => {
                  const shortcut = getShortcutDisplay(cmd);
                  return (
                    <CommandItem
                      key={cmd.id}
                      value={cmd.id}
                      onSelect={handleSelect}
                      keywords={[cmd.label, ...(cmd.keywords ?? [])]}
                      className={flashId === cmd.id ? "bg-primary/20 transition-colors duration-300" : ""}
                    >
                      {cmd.icon && <span className="mr-2">{cmd.icon}</span>}
                      <span>{cmd.label}</span>
                      {cmd.subInput && <ChevronRight className="ml-auto size-3.5 text-muted-foreground" />}
                      {shortcut && <CommandShortcut>{shortcut}</CommandShortcut>}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ))}
          </CommandList>
        </>
      )}
    </CommandDialog>
  );
}
