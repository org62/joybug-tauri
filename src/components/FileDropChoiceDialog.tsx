import { Bug, FileSearch } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { moduleBasename } from "@/lib/sessionHelpers";

export interface FileDropChoiceDialogProps {
  /** The dropped executable awaiting a choice; null keeps the dialog closed. */
  path: string | null;
  onClose: () => void;
  onDebug: () => void;
  onInspect: () => void;
}

/**
 * Asked when an .exe is dropped on a route that doesn't handle drops itself:
 * both actions are valid for an executable, so let the user pick rather than
 * guessing. Non-launchable PE files skip this and go straight to the viewer.
 */
export function FileDropChoiceDialog({ path, onClose, onDebug, onInspect }: FileDropChoiceDialogProps) {
  return (
    <Dialog open={path !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-md" data-testid="file-drop-choice">
        <DialogHeader>
          <DialogTitle>Open {path ? moduleBasename(path) : "file"}</DialogTitle>
          <DialogDescription className="break-all font-mono text-xs">{path}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-2">
          <Button
            variant="outline"
            className="h-auto justify-start gap-3 px-3 py-3 text-left"
            onClick={onDebug}
            data-testid="file-drop-choice-debug"
          >
            <Bug className="size-5 shrink-0 text-muted-foreground" />
            <span className="flex flex-col gap-0.5">
              <span className="font-medium">Debug</span>
              <span className="text-xs font-normal text-muted-foreground">
                Launch it under the debugger in a new session
              </span>
            </span>
          </Button>
          <Button
            variant="outline"
            className="h-auto justify-start gap-3 px-3 py-3 text-left"
            onClick={onInspect}
            data-testid="file-drop-choice-pe"
          >
            <FileSearch className="size-5 shrink-0 text-muted-foreground" />
            <span className="flex flex-col gap-0.5">
              <span className="font-medium">PE Viewer</span>
              <span className="text-xs font-normal text-muted-foreground">
                Inspect headers, symbols and disassembly without running it
              </span>
            </span>
          </Button>
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
