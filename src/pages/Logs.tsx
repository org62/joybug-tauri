import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function Logs() {
  return (
    <div className="container mx-auto p-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-2xl">Application Logs</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div className="p-4 bg-gray-100 dark:bg-neutral-800 rounded-lg">
              <div className="text-sm text-gray-500 dark:text-neutral-400">2024-01-20 10:30:15</div>
              <div className="text-green-600 dark:text-green-400">✓ Application started successfully</div>
            </div>
            <div className="p-4 bg-gray-100 dark:bg-neutral-800 rounded-lg">
              <div className="text-sm text-gray-500 dark:text-neutral-400">2024-01-20 10:30:20</div>
              <div className="text-blue-600 dark:text-blue-400">ℹ User interface initialized</div>
            </div>
            <div className="p-4 bg-gray-100 dark:bg-neutral-800 rounded-lg">
              <div className="text-sm text-gray-500 dark:text-neutral-400">2024-01-20 10:30:25</div>
              <div className="text-yellow-600 dark:text-yellow-400">⚠ Configuration file loaded with default values</div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
} 