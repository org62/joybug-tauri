import { Card, CardContent, CardHeader } from "@/components/ui/card";
import reactLogo from "../assets/react.svg";

export default function About() {
  return (
    <div className="container mx-auto p-6 flex justify-center">
      <div className="max-w-2xl w-full">
        <Card className="overflow-hidden">
          <CardHeader className="p-0">
            <div className="flex flex-col items-center text-center">
              <img src="/joybug.png" className="joybug w-32 h-32 mb-4 rounded-lg" alt="Joybug Logo" />
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            <div>
              <p className="text-center text-lg text-gray-700 dark:text-neutral-300">
                This project was crafted with a simple philosophy: to enjoy its design, development, and maintenance. The author hopes you'll love using it as much as they loved creating it.
              </p>
            </div>

            <div className="text-center">
              <h4 className="font-medium mb-4 text-xl">Powered by an Amazing Stack</h4>
              <div className="flex justify-center items-center space-x-6">
                <a href="https://tauri.app" target="_blank" rel="noopener noreferrer">
                  <img src="/tauri.svg" className="logo tauri w-24 h-24" alt="Tauri logo" />
                </a>
                <a href="https://vitejs.dev" target="_blank" rel="noopener noreferrer">
                  <img src="/vite.svg" className="logo vite w-24 h-24" alt="Vite logo" />
                </a>
                <a href="https://reactjs.org" target="_blank" rel="noopener noreferrer">
                  <img src={reactLogo} className="logo react w-24 h-24" alt="React logo" />
                </a>
                <a href="https://www.rust-lang.org" target="_blank" rel="noopener noreferrer">
                  <img src="/rust.svg" className="logo rust w-24 h-24" alt="Rust logo" />
                </a>

              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-4">
                <div className="p-4 bg-gray-50 dark:bg-neutral-800 rounded-lg">
                    <h4 className="font-medium mb-2">Technologies</h4>
                    <ul className="text-sm text-gray-600 dark:text-neutral-400 space-y-1">
                        <li>• Tauri </li>
                        <li>• Rust </li>
                        <li>• React </li>
                        <li>• TypeScript</li>
                        <li>• Vite</li>
                        <li>• shadcn/ui </li>
                        <li>• Tailwind CSS</li>
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
    </div>
  );
} 