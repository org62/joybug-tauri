import { FileDown } from "lucide-react";

/**
 * Full-window visual affordance shown while a file is dragged over the app.
 * Purely visual (`pointer-events-none`) — the drop itself is handled natively
 * by Tauri via useFileDrop.
 */
export function FileDropOverlay({ active, message }: { active: boolean; message: string }) {
  if (!active) return null;
  return (
    <div
      data-testid="file-drop-overlay"
      className="fixed inset-0 z-50 pointer-events-none bg-background/80"
    >
      <div className="absolute inset-0 m-4 rounded-lg border-2 border-dashed border-primary flex flex-col items-center justify-center gap-3">
        <FileDown className="h-10 w-10 text-primary" />
        <span className="text-lg font-medium text-foreground select-none">{message}</span>
      </div>
    </div>
  );
}
