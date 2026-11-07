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
import { SettingsRow, SETTING_CONTROL_WIDTH } from "./SettingsSection";
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
  // An action the preset leaves unbound has no entry there at all.
  const presetDefault = KEYBINDING_PRESETS[preset][actionId] ?? "";
  const isCustomized = currentChord !== presetDefault;

  const handleCapture = (chord: ChordString) => {
    const conflictLabel = checkConflict(chord, actionId);
    if (conflictLabel) {
      toast.warning(`"${formatKeybinding(chord)}" is already assigned to "${conflictLabel}"`);
    }
    onChange(actionId, chord);
    setIsCapturing(false);
  };

  return (
    <SettingsRow label={meta.label}>
      {/* The row's actions come before the shortcut and only on hover, so the
          shortcut itself — one fixed-width control at the right edge — stands
          in the same place on every row, set or not, customized or not. */}
      {!isCapturing && isCustomized && (
        <Button
          variant="ghost"
          size="icon-xs"
          className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          onClick={() => onReset(actionId)}
          title={`Reset to ${preset} default (${presetDefault ? formatKeybinding(presetDefault) : "not set"})`}
        >
          <RotateCcw />
        </Button>
      )}
      {!isCapturing && currentChord && (
        <Button
          variant="ghost"
          size="icon-xs"
          className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          onClick={() => onChange(actionId, "")}
          title="Remove keybinding"
        >
          <X />
        </Button>
      )}
      {isCapturing ? (
        <KeyCaptureInput onCapture={handleCapture} onCancel={() => setIsCapturing(false)} />
      ) : (
        <Button
          variant="outline"
          size="xs"
          onClick={() => setIsCapturing(true)}
          className={cn(
            SETTING_CONTROL_WIDTH,
            "font-mono hover:border-ring hover:bg-accent/50",
            isCustomized && "border-syn-state/50 bg-syn-state/5",
            !currentChord && "text-muted-foreground italic"
          )}
        >
          {currentChord ? formatKeybinding(currentChord) : "Not set"}
        </Button>
      )}
    </SettingsRow>
  );
}
