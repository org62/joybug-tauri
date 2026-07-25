import { useState } from "react";
import { Bug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { useDebugSettings } from "@/hooks/useDebugSettings";
import {
  dismissWelcome,
  openExternal,
  GITHUB_ISSUES_URL,
  type WelcomeState,
} from "@/lib/updates";

interface WelcomeDialogProps {
  state: WelcomeState;
  /** Called once the choice is persisted, so the update check can run next. */
  onDismissed: () => void;
}

/**
 * First run of each newly released version: says this is a beta, points at
 * GitHub issues, and captures the auto-update preference.
 *
 * Not dismissable by Escape or an overlay click — the checkbox value is only
 * written on "Get started", so an accidental dismiss would silently discard it.
 */
export function WelcomeDialog({ state, onDismissed }: WelcomeDialogProps) {
  const { settings, toggle } = useDebugSettings();
  // Local until "Get started": the checkbox is a draft, and closing any other
  // way must not persist it.
  const [draft, setDraft] = useState<boolean | null>(null);
  const autoUpdateCheck = draft ?? settings.auto_update_check;
  const [saving, setSaving] = useState(false);

  const handleGetStarted = async () => {
    setSaving(true);
    try {
      // Settings go through the normal settings command so there stays one
      // writer for settings.json; dismiss_welcome only stamps app_state.json.
      if (autoUpdateCheck !== settings.auto_update_check) {
        await toggle("auto_update_check");
      }
      await dismissWelcome();
    } catch (e) {
      // Persisting failed, so the dialog will return on the next launch. Not
      // worth trapping the user here.
      console.error("Failed to record welcome dismissal:", e);
    }
    setSaving(false);
    onDismissed();
  };

  return (
    <Dialog open>
      <DialogContent
        className="sm:max-w-lg"
        showCloseButton={false}
        data-testid="welcome-dialog"
        onEscapeKeyDown={(e) => e.preventDefault()}
        // onInteractOutside covers pointer-down and focus-outside both.
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="text-base">
            Welcome to Joybug UI {state.version}
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            This is a beta release.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          <p>
            Joybug is a young debugger and this build is still beta — expect
            rough edges, and expect to hit bugs.
          </p>
          <p>
            If something crashes, misbehaves, or just looks wrong, please open a
            GitHub issue. Bug reports are by far the fastest way to get things
            fixed, and every one of them helps.
          </p>
        </div>

        <div className="flex items-center gap-2 rounded border bg-muted/40 px-3 py-2">
          <Checkbox
            id="welcome-auto-update"
            checked={autoUpdateCheck}
            onCheckedChange={(checked) => setDraft(checked === true)}
          />
          <Label htmlFor="welcome-auto-update" className="text-sm font-normal">
            Automatically check for updates
          </Label>
        </div>
        <p className="text-xs text-muted-foreground -mt-1">
          You can change this any time in Settings → General.
        </p>

        <DialogFooter className="sm:justify-between">
          <Button
            variant="outline"
            size="sm"
            onClick={() => openExternal(GITHUB_ISSUES_URL)}
          >
            <Bug className="size-4" />
            Report an issue
          </Button>
          <Button size="sm" onClick={handleGetStarted} disabled={saving}>
            Get started
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
