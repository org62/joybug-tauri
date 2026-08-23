import React from "react";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { ADDR_MODE_LABELS, AddrMode } from "@/lib/peAddress";

// Derived from the label map so a new mode is declared in exactly one place.
const MODES = Object.keys(ADDR_MODE_LABELS) as AddrMode[];

/** Address display-mode picker (VA / RVA / file offset), shared by the
 *  standalone PE viewer's toolbar and the session PE Viewer panel. */
export const AddrModeSelect: React.FC<{
  value: AddrMode;
  onChange: (mode: AddrMode) => void;
  className?: string;
  "data-testid"?: string;
}> = ({ value, onChange, className, "data-testid": testId }) => (
  <Select value={value} onValueChange={(v) => onChange(v as AddrMode)}>
    <SelectTrigger size="xs" className={className} title="Address display mode" data-testid={testId}>
      <SelectValue />
    </SelectTrigger>
    <SelectContent>
      {MODES.map((m) => (
        <SelectItem key={m} value={m} className="text-xs">{ADDR_MODE_LABELS[m]}</SelectItem>
      ))}
    </SelectContent>
  </Select>
);
