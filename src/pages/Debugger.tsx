import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Play, Settings, Rocket } from "lucide-react";
import { toast } from "sonner";

export default function Debugger() {
  const [serverUrl, setServerUrl] = useState("http://localhost:8080");
  const [launchCommand, setLaunchCommand] = useState("cmd.exe /c echo Hello World!");
  const [isConnecting, setIsConnecting] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [isLaunching, setIsLaunching] = useState(false);

  const handleCreateClient = async () => {
    try {
      setIsConnecting(true);
      await invoke("create_debug_client", { baseUrl: serverUrl });
      
      // Test the connection by pinging the server
      await invoke("ping");
      setIsConnected(true);
      toast.success("Debug client connected successfully");
    } catch (error) {
      console.error("Failed to connect to debug server:", error);
      toast.error(`Failed to connect to debug server: ${error}`);
      setIsConnected(false);
    } finally {
      setIsConnecting(false);
    }
  };

  const handlePing = async () => {
    try {
      setIsConnecting(true);
      await invoke("ping");
      toast.success("Debug server ping successful");
    } catch (error) {
      console.error("Ping failed:", error);
      toast.error(`Ping failed: ${error}`);
    } finally {
      setIsConnecting(false);
    }
  };

  const handleLaunch = async () => {
    try {
      setIsLaunching(true);
      
      // Always connect first before launching
      try {
        await invoke("create_debug_client", { baseUrl: serverUrl });
        await invoke("ping");
        setIsConnected(true);
        toast.success("Debug client connected successfully");
      } catch (error) {
        console.error("Failed to connect to debug server:", error);
        toast.error(`Failed to connect to debug server: ${error}`);
        setIsConnected(false);
        return; // Don't proceed with launch if connection fails
      }
      
      await invoke("launch", { command: launchCommand });
      toast.success("Process launched successfully");
    } catch (error) {
      console.error("Failed to launch process:", error);
      toast.error(`Failed to launch process: ${error}`);
    } finally {
      setIsLaunching(false);
    }
  };

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="max-w-4xl mx-auto space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-2xl">Debug Server Configuration</CardTitle>
            <CardDescription>
              Configure the debug server connection settings
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="serverUrl">Debug Server URL</Label>
              <Input
                id="serverUrl"
                value={serverUrl}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setServerUrl(e.target.value)}
                placeholder="http://localhost:8080"
                disabled={isConnecting || isLaunching}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="launchCommand">Launch Command</Label>
              <Input
                id="launchCommand"
                value={launchCommand}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setLaunchCommand(e.target.value)}
                placeholder="npm run debug-server"
                disabled={isConnecting || isLaunching}
              />
            </div>
            <div className="flex gap-2 flex-wrap">
              <Button 
                onClick={handleLaunch}
                disabled={isConnecting || isLaunching || !launchCommand.trim()}
                variant="default"
                className="flex items-center gap-2"
              >
                <Rocket className="h-4 w-4" />
                {isLaunching ? "Launching..." : "Launch process"}
              </Button>
              <Button 
                onClick={handlePing}
                disabled={isConnecting || isLaunching}
                variant="outline"
                className="flex items-center gap-2"
              >
                <Settings className="h-4 w-4" />
                {isConnecting ? "Checking..." : "Check connection"}
              </Button>
              {isConnected && (
                <div className="flex items-center text-sm text-green-600 dark:text-green-400">
                  ✓ Debug client ready
                </div>
              )}
            </div>
          </CardContent>
        </Card>

      </div>
    </div>
  );
} 