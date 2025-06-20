import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Settings, Rocket, Plus, Trash2, RefreshCw, Play, Square, ExternalLink } from "lucide-react";
import { toast } from "sonner";

interface LaunchConfiguration {
  id: string;
  name: string;
  serverUrl: string;
  launchCommand: string;
  isConnected: boolean;
  isConnecting: boolean;
  isLaunching: boolean;
}

export default function Debugger() {
  const navigate = useNavigate();
  const [configs, setConfigs] = useState<LaunchConfiguration[]>([]);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingConfig, setEditingConfig] = useState<LaunchConfiguration | null>(null);
  
  // Running sessions state
  const [runningSessions, setRunningSessions] = useState<string[]>([]);
  const [isLoadingSessions, setIsLoadingSessions] = useState(false);
  const [terminatingSessions, setTerminatingSessions] = useState<Set<string>>(new Set());
  
  // Form state for dialog
  const [formServerUrl, setFormServerUrl] = useState("http://localhost:8080");
  const [formLaunchCommand, setFormLaunchCommand] = useState("cmd.exe /c echo Hello World!");
  const [formConfigName, setFormConfigName] = useState("");

  // Load configs from localStorage on component mount
  useEffect(() => {
    const savedConfigs = localStorage.getItem('savedConfigs');
    if (savedConfigs) {
      try {
        const parsedConfigs = JSON.parse(savedConfigs);
        // Reset connection states since they shouldn't persist
        const cleanedConfigs = parsedConfigs.map((config: LaunchConfiguration) => ({
          ...config,
          isConnected: false,
          isConnecting: false,
          isLaunching: false,
        }));
        setConfigs(cleanedConfigs);
      } catch (error) {
        console.error('Failed to parse saved configs:', error);
        localStorage.removeItem('savedConfigs');
      }
    }
  }, []);

  // Save sessions to localStorage whenever sessions change
  useEffect(() => {
    if (configs.length > 0) {
      localStorage.setItem('savedConfigs', JSON.stringify(configs));
    } else {
      localStorage.removeItem('savedConfigs');
    }
  }, [configs]);

  const handlePing = async (sessionId: string) => {
    try {
      setConfigs(prev => prev.map(s => 
        s.id === sessionId ? { ...s, isConnecting: true } : s
      ));
      
      await invoke("ping");
      toast.success("Debug server ping successful");
    } catch (error) {
      console.error("Ping failed:", error);
      toast.error(`Ping failed: ${error}`);
    } finally {
      setConfigs(prev => prev.map(s => 
        s.id === sessionId ? { ...s, isConnecting: false } : s
      ));
    }
  };

  const handleLaunch = async (sessionId: string) => {
    const session = configs.find(s => s.id === sessionId);
    if (!session) return;

    try {
      setConfigs(prev => prev.map(s => 
        s.id === sessionId ? { ...s, isLaunching: true } : s
      ));
      
      // Always connect first before launching
      try {
        await invoke("create_debug_client", { baseUrl: session.serverUrl });
        await invoke("ping");
        
        setConfigs(prev => prev.map(s => 
          s.id === sessionId ? { ...s, isConnected: true } : s
        ));
        
        toast.success("Debug client connected successfully");
      } catch (error) {
        console.error("Failed to connect to debug server:", error);
        toast.error(`Failed to connect to debug server: ${error}`);
        
        setConfigs(prev => prev.map(s => 
          s.id === sessionId ? { ...s, isConnected: false, isLaunching: false } : s
        ));
        return;
      }
      
      await invoke("launch", { command: session.launchCommand });
      toast.success("Process launched successfully");
      
      // Refresh running sessions after successful launch
      fetchRunningSessions();
    } catch (error) {
      console.error("Failed to launch process:", error);
      toast.error(`Failed to launch process: ${error}`);
    } finally {
      setConfigs(prev => prev.map(s => 
        s.id === sessionId ? { ...s, isLaunching: false } : s
      ));
    }
  };

  const handleAddSession = () => {
    setEditingConfig(null);
    setFormConfigName("");
    setFormServerUrl("http://localhost:8080");
    setFormLaunchCommand("cmd.exe /c echo Hello World!");
    setIsDialogOpen(true);
  };

  const handleEditSession = (session: LaunchConfiguration) => {
    setEditingConfig(session);
    setFormConfigName(session.name);
    setFormServerUrl(session.serverUrl);
    setFormLaunchCommand(session.launchCommand);
    setIsDialogOpen(true);
  };

  const handleSaveSession = () => {
    const sessionName = formConfigName.trim() || `Config ${Date.now()}`;

    if (editingConfig) {
      // Update existing session
      setConfigs(prev => prev.map(s => 
        s.id === editingConfig.id 
          ? { 
              ...s, 
              name: sessionName,
              serverUrl: formServerUrl,
              launchCommand: formLaunchCommand 
            }
          : s
      ));
      toast.success("Configuration updated successfully");
      setIsDialogOpen(false);
    } else {
      // Add new session
      const newSessionId = Date.now().toString();
      const newSession: LaunchConfiguration = {
        id: newSessionId,
        name: sessionName,
        serverUrl: formServerUrl,
        launchCommand: formLaunchCommand,
        isConnected: false,
        isConnecting: false,
        isLaunching: false,
      };
      
      setConfigs(prev => [...prev, newSession]);
      toast.success("Configuration created successfully");
      setIsDialogOpen(false);
      
      // Automatically launch the new session
      setTimeout(() => {
        handleLaunch(newSessionId);
      }, 100); // Small delay to ensure state is updated
    }
  };

  const handleDeleteSession = (sessionId: string) => {
    setConfigs(prev => prev.filter(s => s.id !== sessionId));
    toast.success("Configuration deleted");
  };

  const fetchRunningSessions = async () => {
    // Get the server URL from the first configuration, or use default
    const serverUrl = configs.length > 0 ? configs[0].serverUrl : "http://localhost:8080";
    
    try {
      setIsLoadingSessions(true);
      const sessions = await invoke<string[]>("list_running_sessions", { serverUrl });
      setRunningSessions(sessions);
      if (sessions.length > 0) {
        toast.success(`Found ${sessions.length} running sessions`);
      }
    } catch (error) {
      console.error("Failed to fetch running sessions:", error);
      toast.error(`Failed to fetch running sessions: ${error}`);
      setRunningSessions([]);
    } finally {
      setIsLoadingSessions(false);
    }
  };

  const handleTerminateSession = async (sessionId: string) => {
    // Get the server URL from the first configuration, or use default
    const serverUrl = configs.length > 0 ? configs[0].serverUrl : "http://localhost:8080";
    
    try {
      setTerminatingSessions(prev => new Set(prev).add(sessionId));
      
      await invoke("terminate_session", { 
        serverUrl, 
        sessionId 
      });
      
      toast.success(`Session ${sessionId} terminated successfully`);
      
      // Refresh the sessions list after termination
      await fetchRunningSessions();
    } catch (error) {
      console.error("Failed to terminate session:", error);
      toast.error(`Failed to terminate session: ${error}`);
    } finally {
      setTerminatingSessions(prev => {
        const newSet = new Set(prev);
        newSet.delete(sessionId);
        return newSet;
      });
    }
  };

  // Auto-refresh disabled - users can manually refresh using the button
  // useEffect(() => {
  //   if (configs.length === 0) return;

  //   const interval = setInterval(() => {
  //     fetchRunningSessions();
  //   }, 5000);

  //   // Initial fetch
  //   fetchRunningSessions();

  //   return () => clearInterval(interval);
  // }, [configs.length]);

  // Fetch sessions when component mounts and when configs change
  useEffect(() => {
    if (configs.length > 0) {
      fetchRunningSessions();
    }
  }, [configs.length]);

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="max-w-4xl mx-auto space-y-6">
                 <div className="flex items-center justify-between">
           <div>
             <h1 className="text-3xl font-bold">Launch Configurations</h1>
             <p className="text-muted-foreground">Manage your debug launch configurations</p>
           </div>
           
           <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
             <DialogTrigger asChild>
               <Button onClick={handleAddSession} className="flex items-center gap-2">
                 <Plus className="h-4 w-4" />
                 New Configuration
               </Button>
             </DialogTrigger>
            <DialogContent className="sm:max-w-[425px]">
                             <DialogHeader>
                 <DialogTitle>
                   {editingConfig ? "Edit Launch Configuration" : "New Launch Configuration"}
                 </DialogTitle>
                 <DialogDescription>
                   Configure the debug server connection settings
                 </DialogDescription>
               </DialogHeader>
              <div className="space-y-4 py-4">
                                 <div className="space-y-2">
                   <Label htmlFor="sessionName">Configuration Name</Label>
                   <Input
                     id="sessionName"
                     value={formConfigName}
                     onChange={(e) => setFormConfigName(e.target.value)}
                     placeholder="My Launch Configuration"
                   />
                 </div>
                <div className="space-y-2">
                  <Label htmlFor="serverUrl">Debug Server URL</Label>
                  <Input
                    id="serverUrl"
                    value={formServerUrl}
                    onChange={(e) => setFormServerUrl(e.target.value)}
                    placeholder="http://localhost:8080"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="launchCommand">Launch Command</Label>
                  <Input
                    id="launchCommand"
                    value={formLaunchCommand}
                    onChange={(e) => setFormLaunchCommand(e.target.value)}
                    placeholder="cmd.exe /c echo Hello World!"
                  />
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setIsDialogOpen(false)}>
                  Cancel
                </Button>
                                 <Button onClick={handleSaveSession}>
                   {editingConfig ? "Update" : "Create"} Configuration
                 </Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>

                 {configs.length === 0 ? (
           <Card>
             <CardContent className="flex flex-col items-center justify-center py-12 text-center">
               <div className="text-muted-foreground text-lg mb-4">No launch configurations yet</div>
               <p className="text-sm text-muted-foreground mb-6">
                 Create your first launch configuration to get started
               </p>
               <Button onClick={handleAddSession} className="flex items-center gap-2">
                 <Plus className="h-4 w-4" />
                 Create Configuration
               </Button>
             </CardContent>
           </Card>
        ) : (
          <div className="space-y-4">
            {configs.map((session) => (
              <Card key={session.id}>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle className="text-xl">{session.name}</CardTitle>
                      <CardDescription>{session.serverUrl}</CardDescription>
                    </div>
                    <div className="flex items-center gap-2">
                      {session.isConnected && (
                        <Badge variant="default" className="bg-green-600">
                          Connected
                        </Badge>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleEditSession(session)}
                      >
                        <Settings className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleDeleteSession(session.id)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="flex gap-2 flex-wrap">
                    <Button 
                      onClick={() => handleLaunch(session.id)}
                      disabled={session.isConnecting || session.isLaunching || !session.launchCommand.trim()}
                      variant="default"
                      className="flex items-center gap-2"
                    >
                      <Rocket className="h-4 w-4" />
                      {session.isLaunching ? "Launching..." : "Launch"}
                    </Button>
                    <Button 
                      onClick={() => handlePing(session.id)}
                      disabled={session.isConnecting || session.isLaunching}
                      variant="outline"
                      className="flex items-center gap-2"
                    >
                      <Settings className="h-4 w-4" />
                      {session.isConnecting ? "Checking..." : "Ping"}
                    </Button>
                  </div>
                  {session.launchCommand && (
                    <div className="mt-3 text-sm text-muted-foreground">
                      <strong>Command:</strong> {session.launchCommand}
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {/* Running Sessions Section */}
        {configs.length > 0 && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-2xl font-bold">Running Debug Sessions</h2>
                <p className="text-muted-foreground">
                  Currently active debug sessions on server: {configs[0]?.serverUrl || "http://localhost:8080"}
                </p>
              </div>
              <Button
                onClick={fetchRunningSessions}
                disabled={isLoadingSessions}
                variant="outline"
                size="sm"
                className="flex items-center gap-2"
              >
                <RefreshCw className={`h-4 w-4 ${isLoadingSessions ? 'animate-spin' : ''}`} />
                {isLoadingSessions ? 'Refreshing...' : 'Refresh'}
              </Button>
            </div>

          {runningSessions.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center justify-center py-8 text-center">
                <div className="text-muted-foreground text-base mb-2">No active debug sessions</div>
                <p className="text-sm text-muted-foreground">
                  Launch a configuration to create debug sessions
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {runningSessions.map((sessionId, index) => (
                <Card key={sessionId} className="hover:shadow-lg transition-shadow cursor-pointer">
                  <CardHeader className="pb-3">
                    <div className="flex items-center justify-between">
                      <div onClick={() => navigate(`/session/${sessionId}`)} className="flex-1">
                        <CardTitle className="text-lg flex items-center gap-2">
                          Session {index + 1}
                          <ExternalLink className="h-4 w-4 text-muted-foreground" />
                        </CardTitle>
                        <CardDescription className="text-xs font-mono">
                          {sessionId}
                        </CardDescription>
                      </div>
                      <Badge variant="default" className="bg-green-600">
                        <Play className="h-3 w-3 mr-1" />
                        Active
                      </Badge>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="text-sm text-muted-foreground mb-3">
                      <strong>Session ID:</strong> {sessionId}
                    </div>
                    <div className="flex gap-2">
                      <Button
                        onClick={() => navigate(`/session/${sessionId}`)}
                        variant="outline"
                        size="sm"
                        className="flex items-center gap-2"
                      >
                        <ExternalLink className="h-4 w-4" />
                        Debug
                      </Button>
                      <Button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleTerminateSession(sessionId);
                        }}
                        disabled={terminatingSessions.has(sessionId)}
                        variant="destructive"
                        size="sm"
                        className="flex items-center gap-2"
                      >
                        <Square className="h-4 w-4" />
                        {terminatingSessions.has(sessionId) ? "Terminating..." : "Terminate"}
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
                         </div>
           )}
          </div>
        )}
      </div>
    </div>
  );
} 