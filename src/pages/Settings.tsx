import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Search } from "lucide-react";
import { SettingsGeneral } from "@/components/settings/SettingsGeneral";
import { SettingsKeybindings } from "@/components/settings/SettingsKeybindings";
import { SettingsEvents } from "@/components/settings/SettingsEvents";

const SECTION_GRID = "grid gap-x-6 gap-y-5 items-start";
const SECTION_GRID_COLS = { gridTemplateColumns: "repeat(auto-fill, minmax(20rem, 1fr))" };

export default function Settings() {
  const [searchQuery, setSearchQuery] = useState("");
  const [tab, setTab] = useState("all");

  // Auto-switch to "All" tab when user types a search query
  const handleSearchChange = (value: string) => {
    setSearchQuery(value);
    if (value && tab !== "all") {
      setTab("all");
    }
  };

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] p-6">
      <Card className="flex flex-col min-h-0 flex-1">
        <CardHeader className="shrink-0">
          <CardTitle className="text-2xl">Settings</CardTitle>
          <div className="relative mt-2">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search settings..."
              value={searchQuery}
              onChange={(e) => handleSearchChange(e.target.value)}
              className="pl-9"
            />
          </div>
        </CardHeader>
        <CardContent className="flex flex-col min-h-0 flex-1">
          <Tabs value={tab} onValueChange={setTab} className="flex flex-col min-h-0 flex-1">
            <TabsList className="shrink-0">
              <TabsTrigger value="all">All</TabsTrigger>
              <TabsTrigger value="general">General</TabsTrigger>
              <TabsTrigger value="keybindings">Keyboard Shortcuts</TabsTrigger>
              <TabsTrigger value="events">Events and Exceptions</TabsTrigger>
            </TabsList>

            {/* All: one flat grid with every section as a grid item */}
            <TabsContent value="all" className="mt-4 min-h-0 flex-1">
              <ScrollArea className="h-full">
                <div className={SECTION_GRID} style={SECTION_GRID_COLS}>
                  <SettingsGeneral searchQuery={searchQuery} />
                  <SettingsEvents searchQuery={searchQuery} />
                  <SettingsKeybindings searchQuery={searchQuery} embedded />
                </div>
              </ScrollArea>
            </TabsContent>

            {/* General only */}
            <TabsContent value="general" className="mt-4 min-h-0 flex-1">
              <ScrollArea className="h-full">
                <div className={SECTION_GRID} style={SECTION_GRID_COLS}>
                  <SettingsGeneral searchQuery={searchQuery} />
                </div>
              </ScrollArea>
            </TabsContent>

            {/* Keyboard Shortcuts only */}
            <TabsContent value="keybindings" className="mt-4 min-h-0 flex-1">
              <SettingsKeybindings searchQuery={searchQuery} />
            </TabsContent>

            {/* Events and Exceptions only */}
            <TabsContent value="events" className="mt-4 min-h-0 flex-1">
              <ScrollArea className="h-full">
                <div className={SECTION_GRID} style={SECTION_GRID_COLS}>
                  <SettingsEvents searchQuery={searchQuery} />
                </div>
              </ScrollArea>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}
