import React, { useState, useCallback } from "react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import { useCommandPaletteContext } from "@/contexts/CommandPaletteContext";
import { useKeybindingContext } from "@/contexts/KeybindingContext";
import type { ActionId } from "@/lib/keybindings";

export function CommandPalette() {
  const { isOpen, setOpen, commands, subInput, clearSubInput } = useCommandPaletteContext();
  const { getKeybinding } = useKeybindingContext();
  const [subInputValue, setSubInputValue] = useState("");

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
      if (cmd) {
        setOpen(false);
        cmd.onSelect();
      }
    },
    [commands, setOpen]
  );

  const handleOpenChange = useCallback(
    (open: boolean) => {
      setOpen(open);
      if (!open) {
        setSubInputValue("");
      }
    },
    [setOpen]
  );

  const handleSubInputKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && subInput) {
        e.preventDefault();
        const value = subInputValue.trim();
        if (value) {
          subInput.onSubmit(value);
          setSubInputValue("");
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
    <CommandDialog open={isOpen} onOpenChange={handleOpenChange}>
      {subInput ? (
        <div className="flex items-center border-b px-3">
          <input
            className="placeholder:text-muted-foreground flex h-12 w-full rounded-md bg-transparent py-3 text-sm outline-hidden disabled:cursor-not-allowed disabled:opacity-50"
            placeholder={subInput.placeholder}
            value={subInputValue}
            onChange={(e) => setSubInputValue(e.target.value)}
            onKeyDown={handleSubInputKeyDown}
            autoFocus
          />
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
                    >
                      {cmd.icon && <span className="mr-2">{cmd.icon}</span>}
                      <span>{cmd.label}</span>
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
