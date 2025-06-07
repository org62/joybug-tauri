import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Link } from "react-router-dom";

export default function Home() {
  return (
    <div className="container mx-auto p-6">
      <div className="max-w-4xl mx-auto">
        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold mb-4">Welcome to Your Tauri App</h1>
          <p className="text-lg text-gray-600 dark:text-neutral-400">
            Navigate through the application using the menu in the header
          </p>
        </div>
        
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <Card className="hover:shadow-lg transition-shadow">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                📋 Logs
              </CardTitle>
              <CardDescription>
                View application logs and debug information
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Link to="/logs">
                <Button className="w-full">View Logs</Button>
              </Link>
            </CardContent>
          </Card>

          <Card className="hover:shadow-lg transition-shadow">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                ⚙️ Settings
              </CardTitle>
              <CardDescription>
                Configure application preferences and options
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Link to="/settings">
                <Button className="w-full">Open Settings</Button>
              </Link>
            </CardContent>
          </Card>

          <Card className="hover:shadow-lg transition-shadow">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                ℹ️ About
              </CardTitle>
              <CardDescription>
                Learn more about this application and its technologies
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Link to="/about">
                <Button className="w-full">Learn More</Button>
              </Link>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
} 