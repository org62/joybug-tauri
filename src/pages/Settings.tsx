import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useTheme } from "next-themes";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useEffect, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

export default function Settings() {
  const { theme, setTheme } = useTheme();
  const [settings, setSettings] = useState({
    stop_on_thread_create: true,
    stop_on_thread_exit: false,
    stop_on_dll_load: true,
    stop_on_dll_unload: true,
    stop_on_initial_breakpoint: true,
    stop_on_process_create: true,
  });

  const loadSettings = useCallback(async () => {
    try {
      const s = await invoke<typeof settings>("get_debug_settings");
      setSettings(s);
    } catch (e) {
      console.error("Failed to load settings:", e);
    }
  }, []);

  const saveSettings = useCallback(async (next: typeof settings) => {
    setSettings(next);
    try {
      await invoke("update_debug_settings", { newSettings: next });
    } catch (e) {
      console.error("Failed to update settings:", e);
    }
  }, []);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  return (
    <div className="container mx-auto p-6">
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-2xl">Application Settings</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <div>
              <h3 className="text-lg font-medium mb-3">Appearance</h3>
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <label className="text-sm font-medium">Theme</label>
                    <p className="text-sm text-gray-500 dark:text-neutral-400">
                      Select the color theme for the application.
                    </p>
                  </div>
                  <Select value={theme} onValueChange={setTheme}>
                    <SelectTrigger className="w-[180px]">
                      <SelectValue placeholder="Select theme" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="light">Light</SelectItem>
                      <SelectItem value="dark">Dark</SelectItem>
                      <SelectItem value="system">System</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-2xl">Events and exceptions</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <label className="text-sm font-medium">Process Create</label>
                  <p className="text-sm text-gray-500 dark:text-neutral-400">Pause when a process is created.</p>
                </div>
                <Switch
                  checked={settings.stop_on_process_create}
                  onCheckedChange={(v) => saveSettings({ ...settings, stop_on_process_create: v })}
                />
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <label className="text-sm font-medium">Create thread</label>
                  <p className="text-sm text-gray-500 dark:text-neutral-400">Pause when a new thread is created.</p>
                </div>
                <Switch
                  checked={settings.stop_on_thread_create}
                  onCheckedChange={(v) => saveSettings({ ...settings, stop_on_thread_create: v })}
                />
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <label className="text-sm font-medium">Exit thread</label>
                  <p className="text-sm text-gray-500 dark:text-neutral-400">Pause when a thread exits.</p>
                </div>
                <Switch
                  checked={settings.stop_on_thread_exit}
                  onCheckedChange={(v) => saveSettings({ ...settings, stop_on_thread_exit: v })}
                />
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <label className="text-sm font-medium">Load Module</label>
                  <p className="text-sm text-gray-500 dark:text-neutral-400">Pause when a DLL is loaded.</p>
                </div>
                <Switch
                  checked={settings.stop_on_dll_load}
                  onCheckedChange={(v) => saveSettings({ ...settings, stop_on_dll_load: v })}
                />
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <label className="text-sm font-medium">Unload Module</label>
                  <p className="text-sm text-gray-500 dark:text-neutral-400">Pause when a DLL is unloaded.</p>
                </div>
                <Switch
                  checked={settings.stop_on_dll_unload}
                  onCheckedChange={(v) => saveSettings({ ...settings, stop_on_dll_unload: v })}
                />
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <label className="text-sm font-medium">Initial breakpoint</label>
                  <p className="text-sm text-gray-500 dark:text-neutral-400">Pause at initial breakpoint after launch/attach.</p>
                </div>
                <Switch
                  checked={settings.stop_on_initial_breakpoint}
                  onCheckedChange={(v) => saveSettings({ ...settings, stop_on_initial_breakpoint: v })}
                />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
} 