import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import reactLogo from "../assets/react.svg";

export default function About() {
  return (
    <div className="container mx-auto p-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-2xl">About</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="text-center">
            <div className="flex justify-center mb-4">
              <img src="/vite.svg" className="logo vite w-16 h-16" alt="Vite logo" />
              <img src="/tauri.svg" className="logo tauri w-16 h-16" alt="Tauri logo" />
              <img src={reactLogo} className="logo react w-16 h-16" alt="React logo" />
            </div>
            <h3 className="text-xl font-semibold mb-2">Tauri + React Application</h3>
            <p className="text-gray-600 dark:text-neutral-400 mb-4">
              A modern desktop application built with Tauri, React, and TypeScript
            </p>
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="p-4 bg-gray-50 dark:bg-neutral-800 rounded-lg">
              <h4 className="font-medium mb-2">Technologies</h4>
              <ul className="text-sm text-gray-600 dark:text-neutral-400 space-y-1">
                <li>• Tauri 2.0</li>
                <li>• React 18</li>
                <li>• TypeScript</li>
                <li>• Vite</li>
                <li>• Tailwind CSS</li>
                <li>• shadcn/ui</li>
              </ul>
            </div>
            
            <div className="p-4 bg-gray-50 dark:bg-neutral-800 rounded-lg">
              <h4 className="font-medium mb-2">Features</h4>
              <ul className="text-sm text-gray-600 dark:text-neutral-400 space-y-1">
                <li>• Cross-platform</li>
                <li>• Fast and lightweight</li>
                <li>• Modern UI components</li>
                <li>• Dark mode support</li>
                <li>• Type-safe development</li>
              </ul>
            </div>
          </div>
          
          <div className="text-center pt-4 border-t">
            <p className="text-sm text-gray-500">
              Version 0.1.0 • Built with ❤️ using modern web technologies
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
} 