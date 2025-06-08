import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Play, Settings } from "lucide-react";
import { toast } from "sonner";

export default function Debugger() {
  const [serverUrl, setServerUrl] = useState("http://localhost:8080");
  const [isConnecting, setIsConnecting] = useState(false);
  const [isConnected, setIsConnected] = useState(false);

  const handleCreateClient = async () => {
    try {
      setIsConnecting(true);
      await invoke("create_debug_client", { baseUrl: serverUrl });
      setIsConnected(true);
      toast.success("Debug client created successfully");
    } catch (error) {
      console.error("Failed to create debug client:", error);
      toast.error(`Failed to create debug client: ${error}`);
    } finally {
      setIsConnecting(false);
    }
  };

  const handlePing = async () => {
    try {
      setIsConnecting(true);
      await invoke("ping_debug_server");
      toast.success("Debug server ping successful");
    } catch (error) {
      console.error("Ping failed:", error);
      toast.error(`Ping failed: ${error}`);
    } finally {
      setIsConnecting(false);
    }
  };

  const handlePlayClick = async () => {
    if (!isConnected) {
      await handleCreateClient();
      if (!isConnected) return;
    }
    await handlePing();
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
                disabled={isConnecting}
              />
            </div>
            <div className="flex gap-2">
              <Button 
                onClick={handleCreateClient}
                disabled={isConnecting || isConnected}
                variant="outline"
                className="flex items-center gap-2"
              >
                <Settings className="h-4 w-4" />
                {isConnected ? "Connected" : "Connect"}
              </Button>
              {isConnected && (
                <div className="flex items-center text-sm text-green-600 dark:text-green-400">
                  ✓ Debug client ready
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-2xl">Debugger</CardTitle>
            <CardDescription>
              Debug and test your application functionality
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="flex justify-center">
              <Button 
                onClick={handlePlayClick}
                size="lg"
                className="flex items-center gap-2 px-8 py-4 text-lg"
                disabled={isConnecting}
              >
                <Play className="h-6 w-6" />
                {isConnecting ? "Connecting..." : "Ping Server"}
              </Button>
            </div>
            
            {isConnected && (
              <div className="text-center text-sm text-gray-600 dark:text-gray-400">
                Debug client is connected to {serverUrl}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
} 