import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { toast } from "sonner";
import { Bug, Github, Loader2, RefreshCw, Snail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Page } from "@/components/ui/page";
import { UpdateDialog } from "@/components/UpdateDialog";
import { formatTauriError } from "@/lib/sessionHelpers";
import {
  checkForUpdates,
  openExternal,
  GITHUB_CORE_URL,
  GITHUB_ISSUES_URL,
  GITHUB_UI_URL,
  type UpdateInfo,
} from "@/lib/updates";
import reactLogo from "../assets/react.svg";

export default function About() {
  // Comes from tauri.conf.json, which release CI stamps from the git tag - so
  // this is the real version in a release build and the 0.0.0 placeholder in a
  // local one. Never hardcode it here.
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    // Stays null on failure, which just drops the version from the footer -
    // cosmetic, so it logs rather than toasts.
    getVersion()
      .then(setVersion)
      .catch((error) => console.error("Failed to read app version:", error));
  }, []);

  // Manual update check. Unlike the automatic one this always runs — including
  // on an unstamped local build — and always reports what it found.
  const [checking, setChecking] = useState(false);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);

  const handleCheckForUpdates = async () => {
    setChecking(true);
    try {
      const info = await checkForUpdates();
      // Dev-build check comes first: an unstamped 0.0.0 build is "older" than
      // every release, so update_available is true and the dialog would offer
      // an upgrade that isn't one.
      if (info.is_dev_build) {
        toast.info(`Development build — latest release is ${info.latest_version}`);
      } else if (info.update_available) {
        setUpdate(info);
      } else {
        toast.success(`You're running the latest version (${info.current_version})`);
      }
    } catch (error) {
      toast.error(`Update check failed: ${formatTauriError(error)}`);
    } finally {
      setChecking(false);
    }
  };

  return (
    <Page>
      <div className="max-w-2xl mx-auto space-y-6">
        {/* Every other routed page opens with an h1 plus a muted one-line
            subtitle (see Debugger and Logs). About had no title at all, so it
            started at a 64px mark and a text-lg paragraph. */}
        <div>
          <h1 className="text-3xl font-bold">About</h1>
          <p className="text-muted-foreground">Joybug — a modern Windows debugger</p>
        </div>

        <Card className="overflow-hidden">
          <CardHeader className="p-0">
            <div className="flex flex-col items-center text-center">
              <Snail className="size-16 mb-4 text-syn-accent" aria-label="Joybug" />
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            <div>
              <p className="text-center text-muted-foreground">
                This project was crafted with a simple philosophy: to enjoy its design, development, and maintenance. The author hopes you'll love using it as much as he loved creating it.
              </p>
            </div>

            <div className="text-center">
              <h2 className="text-xl font-semibold mb-4">Powered by an Amazing Stack</h2>
              <div className="flex justify-center items-center space-x-6">
                <a href="https://tauri.app" target="_blank" rel="noopener noreferrer">
                  <img src="/tauri.svg" className="logo tauri size-12" alt="Tauri logo" />
                </a>
                <a href="https://vitejs.dev" target="_blank" rel="noopener noreferrer">
                  <img src="/vite.svg" className="logo vite size-12" alt="Vite logo" />
                </a>
                <a href="https://reactjs.org" target="_blank" rel="noopener noreferrer">
                  <img src={reactLogo} className="logo react size-12" alt="React logo" />
                </a>
                <a href="https://www.rust-lang.org" target="_blank" rel="noopener noreferrer">
                  <img src="/rust.svg" className="logo rust size-12" alt="Rust logo" />
                </a>

              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-4">
                <div className="p-4 bg-muted rounded-lg">
                    <h3 className="font-medium mb-2">Technologies</h3>
                    <ul className="text-sm text-muted-foreground space-y-1">
                        <li>• Tauri </li>
                        <li>• Rust </li>
                        <li>• React </li>
                        <li>• TypeScript</li>
                        <li>• Vite</li>
                        <li>• shadcn/ui </li>
                        <li>• Tailwind CSS</li>
                    </ul>
                </div>
                
                <div className="p-4 bg-muted rounded-lg">
                    <h3 className="font-medium mb-2">Features</h3>
                    <ul className="text-sm text-muted-foreground space-y-1">
                        <li>• Cross-platform</li>
                        <li>• Fast and lightweight</li>
                        <li>• Modern UI components</li>
                        <li>• Dark mode support</li>
                        <li>• Type-safe development</li>
                    </ul>
                </div>
            </div>
            
            <div className="text-center pt-4 border-t space-y-3">
              <p className="text-sm text-muted-foreground">
                {version && <>Version {version} • </>}Built with ❤️ using modern web technologies
              </p>
              {/* openExternal (the opener plugin), never a raw <a target="_blank">
                  — WebView2 has no tab to open one in. */}
              <div className="flex flex-wrap justify-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => openExternal(GITHUB_UI_URL)}
                >
                  <Github className="size-4" />
                  joybug-tauri
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => openExternal(GITHUB_CORE_URL)}
                >
                  <Github className="size-4" />
                  joybug-core
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => openExternal(GITHUB_ISSUES_URL)}
                >
                  <Bug className="size-4" />
                  Report an issue
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleCheckForUpdates}
                  disabled={checking}
                >
                  {checking ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <RefreshCw className="size-4" />
                  )}
                  Check for updates
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
      <UpdateDialog info={update} onClose={() => setUpdate(null)} />
    </Page>
  );
}
