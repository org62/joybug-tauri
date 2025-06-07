import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useTheme } from "@/contexts/ThemeContext";

export default function Settings() {
  const { theme, toggleTheme } = useTheme();

  return (
    <div className="container mx-auto p-6">
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-2xl">Application Settings</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <div>
              <h3 className="text-lg font-medium mb-3">General</h3>
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <label className="text-sm font-medium">Dark Mode</label>
                    <p className="text-sm text-gray-500 dark:text-neutral-400">Toggle dark/light theme</p>
                  </div>
                  <div className="flex items-center space-x-2">
                    <span className="text-sm text-gray-500 dark:text-neutral-400">
                      {theme === 'light' ? '☀️' : '🌙'}
                    </span>
                    <Switch
                      checked={theme === 'dark'}
                      onCheckedChange={toggleTheme}
                    />
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <div>
                    <label className="text-sm font-medium">Auto-save</label>
                    <p className="text-sm text-gray-500 dark:text-neutral-400">Automatically save changes</p>
                  </div>
                  <Switch defaultChecked={true} />
                </div>
                <div className="flex items-center justify-between">
                  <div>
                    <label className="text-sm font-medium">System Theme</label>
                    <p className="text-sm text-gray-500 dark:text-neutral-400">Follow system appearance settings</p>
                  </div>
                  <Switch defaultChecked={false} />
                </div>
              </div>
            </div>
            
            <div>
              <h3 className="text-lg font-medium mb-3">Advanced</h3>
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <label className="text-sm font-medium">Debug Mode</label>
                    <p className="text-sm text-gray-500 dark:text-neutral-400">Enable debugging features</p>
                  </div>
                  <Switch defaultChecked={false} />
                </div>
                <div className="flex items-center justify-between">
                  <div>
                    <label className="text-sm font-medium">Clear Cache</label>
                    <p className="text-sm text-gray-500 dark:text-neutral-400">Clear application cache</p>
                  </div>
                  <Button variant="destructive" size="sm">Clear</Button>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
} 