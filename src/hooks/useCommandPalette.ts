import { useState, useCallback, useRef, useMemo } from "react";
import type { PaletteCommand, CommandPaletteContextData, SubInputState } from "@/contexts/CommandPaletteContext";

export function useCommandPalette(): CommandPaletteContextData {
  const [isOpen, setIsOpen] = useState(false);
  const [subInput, setSubInput] = useState<SubInputState | null>(null);
  const [revision, setRevision] = useState(0);
  const registryRef = useRef(new Map<number, PaletteCommand[]>());
  const nextIdRef = useRef(0);

  const toggle = useCallback(() => {
    setIsOpen((prev) => {
      if (prev) setSubInput(null);
      return !prev;
    });
  }, []);

  const setOpen = useCallback((open: boolean) => {
    setIsOpen(open);
    if (!open) {
      setSubInput(null);
    }
  }, []);

  const registerCommands = useCallback((commands: PaletteCommand[]) => {
    const id = nextIdRef.current++;
    registryRef.current.set(id, commands);
    setRevision((r) => r + 1);

    return () => {
      registryRef.current.delete(id);
      setRevision((r) => r + 1);
    };
  }, []);

  const commands = useMemo(() => {
    // revision is used to trigger recalculation
    void revision;
    const all: PaletteCommand[] = [];
    for (const cmds of registryRef.current.values()) {
      all.push(...cmds);
    }
    return all;
  }, [revision]);

  const enterSubInput = useCallback((state: SubInputState) => {
    setSubInput(state);
  }, []);

  const clearSubInput = useCallback(() => {
    setSubInput(null);
  }, []);

  return {
    isOpen,
    setOpen,
    toggle,
    registerCommands,
    commands,
    enterSubInput,
    subInput,
    clearSubInput,
  };
}
