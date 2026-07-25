import { Download, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { openExternal, skipUpdateVersion, type UpdateInfo } from "@/lib/updates";

interface UpdateDialogProps {
  /** The release to offer; `null` means nothing to show. */
  info: UpdateInfo | null;
  /** Clear `info` — the dialog's own visibility is derived from it. */
  onClose: () => void;
}

function formatPublished(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString();
}

/**
 * Offers a newer release. The app ships as a portable .exe rather than a signed
 * installer, so there is nothing to install in-place — "Download" hands the
 * release page to the browser.
 */
export function UpdateDialog({ info, onClose }: UpdateDialogProps) {
  if (!info) return null;

  const published = formatPublished(info.published_at);

  const handleDownload = async () => {
    await openExternal(info.download_url ?? info.release_url);
    onClose();
  };

  const handleSkip = async () => {
    try {
      await skipUpdateVersion(info.latest_version);
    } catch (e) {
      console.error("Failed to skip update version:", e);
    }
    onClose();
  };

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-lg" data-testid="update-dialog">
        <DialogHeader>
          <DialogTitle className="text-base">
            Joybug UI {info.latest_version} is available
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            You're running {info.current_version}
            {published && ` · released ${published}`}
          </DialogDescription>
        </DialogHeader>

        {info.notes && (
          // Release bodies are GitHub markdown and there's no markdown renderer
          // in the app — show them as-is rather than pulling in a dependency.
          // max-h-* on the root is the supported way to bound a ScrollArea —
          // the viewport picks it up via max-h-[inherit].
          <ScrollArea className="max-h-56 rounded border bg-muted/40">
            <p className="text-xs whitespace-pre-wrap font-mono leading-relaxed p-3">
              {info.notes}
            </p>
          </ScrollArea>
        )}

        <p className="text-xs text-muted-foreground">
          Joybug ships as a portable executable — download it and replace your
          current copy.
        </p>

        <DialogFooter className="sm:justify-between">
          <Button variant="ghost" size="sm" onClick={handleSkip}>
            Skip this version
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={onClose}>
              Later
            </Button>
            <Button size="sm" onClick={handleDownload}>
              {info.download_url ? (
                <Download className="size-4" />
              ) : (
                <ExternalLink className="size-4" />
              )}
              Download {info.latest_version}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
