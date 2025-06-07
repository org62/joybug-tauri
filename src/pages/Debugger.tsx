import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Play } from "lucide-react";

export default function Debugger() {
  const handlePlayClick = () => {
    console.log("Play button clicked");
    // Add your debugger logic here
  };

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="max-w-4xl mx-auto">
        <Card>
          <CardHeader>
            <CardTitle className="text-2xl font-bold">Debugger</CardTitle>
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
              >
                <Play className="h-6 w-6" />
                Play
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
} 