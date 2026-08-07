import { useState, useRef, useEffect, useCallback } from "react";
import { keyboardEventToChord, formatKeybinding, type ChordString } from "@/lib/keybindings";
import { cn } from "@/lib/utils";

interface KeyCaptureInputProps {
  onCapture: (chord: ChordString) => void;
  onCancel: () => void;
}

export function KeyCaptureInput({ onCapture, onCancel }: KeyCaptureInputProps) {
  const [capturedChord, setCapturedChord] = useState<ChordString>("");
  const ref = useRef<HTMLDivElement>(null);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (e.key === "Escape") {
      onCancel();
      return;
    }

    // Confirm the previously captured chord on Enter (before overwriting)
    if (e.key === "Enter" && capturedChord) {
      onCapture(capturedChord);
      return;
    }

    const chord = keyboardEventToChord(e);
    if (!chord) return; // bare modifier

    setCapturedChord(chord);
  }, [capturedChord, onCapture, onCancel]);

  // Confirm on Enter after a chord is set
  const handleKeyUp = useCallback((e: KeyboardEvent) => {
    if (e.key === "Enter") return; // handled in keydown
    // Auto-confirm after releasing keys if we have a non-modifier chord
    if (capturedChord && !["Alt", "Control", "Meta", "Shift"].includes(e.key)) {
      // Small delay to allow seeing the chord before confirming
      setTimeout(() => onCapture(capturedChord), 150);
    }
  }, [capturedChord, onCapture]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();

    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("keyup", handleKeyUp, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("keyup", handleKeyUp, true);
    };
  }, [handleKeyDown, handleKeyUp]);

  // Cancel on outside click
  useEffect(() => {
    const handleMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        if (capturedChord) {
          onCapture(capturedChord);
        } else {
          onCancel();
        }
      }
    };
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [capturedChord, onCapture, onCancel]);

  return (
    <div
      ref={ref}
      tabIndex={0}
      className={cn(
        "inline-flex items-center px-2 py-1 rounded border-2 border-ring bg-accent text-sm font-mono",
        "focus:outline-none min-w-[120px]"
      )}
    >
      {capturedChord ? (
        <span>{formatKeybinding(capturedChord)}</span>
      ) : (
        <span className="text-muted-foreground italic">Press key combination...</span>
      )}
    </div>
  );
}
