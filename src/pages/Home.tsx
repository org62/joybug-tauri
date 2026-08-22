import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Page } from "@/components/ui/page";
import { Link } from "react-router-dom";
import { Bug, FileSearch, ScrollText, Settings, Info } from "lucide-react";

export default function Home() {
  return (
    <Page container={false}>
    <div className="container mx-auto p-6">
      <div className="max-w-4xl mx-auto">
        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold mb-4">Welcome to Joybug</h1>
          <p className="text-lg text-gray-600 dark:text-neutral-400">
            A modern desktop debugger. 
          </p>
        </div>
        
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <Card className="hover:shadow-lg transition-shadow">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Bug className="size-5 text-syn-accent" />
                Start Debugging
              </CardTitle>
              <CardDescription>
                Attach to a process and start debugging
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Link to="/debugger">
                <Button className="w-full">Start Debugging</Button>
              </Link>
            </CardContent>
          </Card>

          <Card className="hover:shadow-lg transition-shadow">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FileSearch className="size-5 text-syn-accent" />
                PE Viewer
              </CardTitle>
              <CardDescription>
                Inspect and edit PE files without running them
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Link to="/pe">
                <Button variant="outline" className="w-full">Open PE Viewer</Button>
              </Link>
            </CardContent>
          </Card>

          <Card className="hover:shadow-lg transition-shadow">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <ScrollText className="size-5 text-syn-accent" />
                Logs
              </CardTitle>
              <CardDescription>
                View Debug Server Configuration and debug information
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Link to="/logs">
                <Button variant="outline" className="w-full">View Logs</Button>
              </Link>
            </CardContent>
          </Card>

          <Card className="hover:shadow-lg transition-shadow">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Settings className="size-5 text-syn-accent" />
                Settings
              </CardTitle>
              <CardDescription>
                Configure application preferences and options
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Link to="/settings">
                <Button variant="outline" className="w-full">Open Settings</Button>
              </Link>
            </CardContent>
          </Card>

          <Card className="hover:shadow-lg transition-shadow">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Info className="size-5 text-syn-accent" />
                About
              </CardTitle>
              <CardDescription>
                Learn more about this application and its technologies
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Link to="/about">
                <Button variant="outline" className="w-full">Learn More</Button>
              </Link>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
    </Page>
  );
}