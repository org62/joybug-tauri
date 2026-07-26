import { useState } from "react";
import { Button } from "@/components/ui/button";
import { X, RotateCcw } from "lucide-react";
import {
  type ActionId,
  type ChordString,
  ACTION_REGISTRY,
  formatKeybinding,
  KEYBINDING_PRESETS,
  type PresetName,
} from "@/lib/keybindings";
import { KeyCaptureInput } from "./KeyCaptureInput";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

interface KeybindingRowProps {
  actionId: ActionId;
  currentChord: ChordString;
  preset: PresetName;
  /** Returns conflicting action label if chord is already assigned, or null */
  checkConflict: (chord: ChordString, excludeAction: ActionId) => string | null;
  onChange: (actionId: ActionId, chord: ChordString) => void;
  onReset: (actionId: ActionId) => void;
}

export function KeybindingRow({ actionId, currentChord, preset, checkConflict, onChange, onReset }: KeybindingRowProps) {
  const [isCapturing, setIsCapturing] = useState(false);
  const meta = ACTION_REGISTRY[actionId];
  const presetDefault = KEYBINDING_PRESETS[preset][actionId];
  const isCustomized = currentChord !== presetDefault;

  const handleCapture = (chord: ChordString) => {
    const conflictLabel = checkConflict(chord, actionId);
    if (conflictLabel) {
      toast.warning(`"${formatKeybinding(chord)}" is already assigned to "${conflictLabel}"`);
    }
    onChange(actionId, chord);
    setIsCapturing(false);
  };

  const handleCancel = () => {
    setIsCapturing(false);
  };

  const handleReset = () => {
    onReset(actionId);
  };

  const handleRemove = () => {
    onChange(actionId, "");
  };

  return (
    <div className="flex items-center justify-between gap-2 py-1.5 px-2 rounded hover:bg-muted/50 group border-b border-border/50">
      {/* Command label */}
      <div className="text-sm font-medium truncate min-w-0">
        {meta.label}
      </div>

      {/* Keybinding + actions */}
      <div className="shrink-0 flex items-center gap-1">
        {isCapturing ? (
          <KeyCaptureInput onCapture={handleCapture} onCancel={handleCancel} />
        ) : (
          <Button
            variant="outline"
            size="xs"
            onClick={() => setIsCapturing(true)}
            className={cn(
              "font-mono",
              "hover:border-ring hover:bg-accent/50",
              isCustomized && "border-syn-state/50 bg-syn-state/5",
              !currentChord && "text-muted-foreground italic"
            )}
          >
            {currentChord ? formatKeybinding(currentChord) : "Not set"}
          </Button>
        )}

        {/* Remove button */}
        {currentChord && !isCapturing && (
          <Button
            variant="ghost"
            size="icon-xs"
            className="opacity-0 group-hover:opacity-100"
            onClick={handleRemove}
            title="Remove keybinding"
          >
            <X />
          </Button>
        )}

        {/* Reset to preset default */}
        {isCustomized && !isCapturing && (
          <Button
            variant="ghost"
            size="icon-xs"
            className="opacity-0 group-hover:opacity-100"
            onClick={handleReset}
            title={`Reset to ${preset} default (${formatKeybinding(presetDefault)})`}
          >
            <RotateCcw />
          </Button>
        )}
      </div>
    </div>
  );
}
