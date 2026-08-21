import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { Download, ExternalLink, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { formatTauriError } from "@/lib/sessionHelpers";
import {
  INSTALL_PROGRESS_EVENT,
  installUpdate,
  openExternal,
  restartApp,
  skipUpdateVersion,
  type InstallProgress,
  type UpdateInfo,
} from "@/lib/updates";

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

function formatMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const PHASE_LABEL: Record<InstallProgress["phase"], string> = {
  checksum: "Fetching checksum…",
  downloading: "Downloading…",
  verifying: "Verifying download…",
  installing: "Installing…",
  done: "Installed — restarting…",
};

/**
 * Offers a newer release. When the release publishes a checksum and Joybug's
 * folder is writable (`info.self_update`), the whole update runs in place —
 * download, verify, swap the exe, relaunch. Otherwise this falls back to what
 * it always did and hands the release page to the browser.
 */
export function UpdateDialog({ info, onClose }: UpdateDialogProps) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<InstallProgress | null>(null);
  const [sessionCount, setSessionCount] = useState(0);
  // Progress events keep arriving between the swap and the process dying;
  // ignore them once this dialog is gone.
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const unlisten = listen<InstallProgress>(INSTALL_PROGRESS_EVENT, (event) => {
      if (mounted.current) setProgress(event.payload);
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  // Restarting takes the debuggees with it, so say so. Only reachable from the
  // About page — the startup check runs before any session exists.
  useEffect(() => {
    if (!info?.self_update.supported) return;
    invoke<unknown[]>("get_debug_sessions")
      .then((sessions) => {
        if (mounted.current) setSessionCount(sessions.length);
      })
      .catch(() => {
        /* sessions unavailable — the advisory is optional */
      });
  }, [info]);

  if (!info) return null;

  const published = formatPublished(info.published_at);
  const canSelfUpdate =
    info.self_update.supported && !!info.download_url && !!info.checksum_url;

  const handleInstall = async () => {
    if (!info.download_url || !info.checksum_url) return;
    setBusy(true);
    setProgress({ phase: "checksum", downloaded: 0, total: info.asset_size });
    try {
      await installUpdate(info.download_url, info.checksum_url);
    } catch (e) {
      toast.error(`Update failed: ${formatTauriError(e)}`);
      if (mounted.current) {
        setBusy(false);
        setProgress(null);
      }
      return;
    }

    // Separate from the install: past this point the new executable is already
    // in place, so a failure here is "restart yourself", not "update failed".
    try {
      await restartApp();
    } catch (e) {
      toast.error(
        `Joybug UI ${info.latest_version} is installed, but the restart failed ` +
          `(${formatTauriError(e)}). Close and reopen Joybug to use it.`,
      );
      if (mounted.current) setBusy(false);
    }
  };

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

  const total = progress?.total ?? info.asset_size ?? null;
  const downloaded = progress?.downloaded ?? 0;
  const percent = total ? (downloaded / total) * 100 : 0;
  const indeterminate = progress?.phase !== "downloading" || !total;

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <DialogContent
        className="sm:max-w-lg"
        data-testid="update-dialog"
        // An interrupted swap is the one moment where closing the app is
        // genuinely destructive, so the dialog holds the door shut.
        showCloseButton={!busy}
        onEscapeKeyDown={(e) => busy && e.preventDefault()}
        onInteractOutside={(e) => busy && e.preventDefault()}
      >
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

        {busy ? (
          <div className="space-y-2" data-testid="update-progress">
            <Progress
              value={percent}
              indeterminate={indeterminate}
              aria-label="Update progress"
            />
            <p className="text-xs text-muted-foreground tabular-nums">
              {PHASE_LABEL[progress?.phase ?? "checksum"]}
              {progress?.phase === "downloading" &&
                ` ${formatMb(downloaded)}${total ? ` / ${formatMb(total)}` : ""}`}
            </p>
          </div>
        ) : (
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">
              {canSelfUpdate
                ? "Joybug will download the new version, check it against the published checksum, replace itself, and restart."
                : `Joybug ships as a portable executable — download it and replace your current copy${
                    info.self_update.reason
                      ? ` (${info.self_update.reason})`
                      : ""
                  }.`}
            </p>
            {canSelfUpdate && sessionCount > 0 && (
              <p className="text-xs text-muted-foreground">
                Restarting will end {sessionCount} active debug session
                {sessionCount === 1 ? "" : "s"}.
              </p>
            )}
          </div>
        )}

        <DialogFooter className="sm:justify-between">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleSkip}
            disabled={busy}
          >
            Skip this version
          </Button>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={onClose}
              disabled={busy}
            >
              Later
            </Button>
            {canSelfUpdate ? (
              <Button size="sm" onClick={handleInstall} disabled={busy}>
                {busy ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Download className="size-4" />
                )}
                Update &amp; restart
              </Button>
            ) : (
              <Button size="sm" onClick={handleDownload}>
                {info.download_url ? (
                  <Download className="size-4" />
                ) : (
                  <ExternalLink className="size-4" />
                )}
                Download {info.latest_version}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
