import { useState, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Page } from "@/components/ui/page";
import { EmptyState, STATE_ICON_CLASS } from "@/components/ui/empty-state";
import { Search, SearchX } from "lucide-react";
import { SettingsGeneral } from "@/components/settings/SettingsGeneral";
import { SettingsKeybindings } from "@/components/settings/SettingsKeybindings";
import { SettingsEvents } from "@/components/settings/SettingsEvents";
import { SettingsPebNormalize } from "@/components/settings/SettingsPebNormalize";
import { SettingsSymbols } from "@/components/settings/SettingsSymbols";
import { SettingsSandbox } from "@/components/settings/SettingsSandbox";
import { SettingsDiagnostics } from "@/components/settings/SettingsDiagnostics";
import { usePlatform } from "@/hooks/usePlatform";
import type { PlatformFeatures } from "@/contexts/PlatformContext";

/**
 * The page is one column of sections, top to bottom, in this order. A tab
 * narrows the column to its sections ("All" shows every one); it never
 * rearranges them, so a setting is always found in the same place.
 */
const SECTIONS: { tab: string; Section: React.ComponentType<{ searchQuery: string }> }[] = [
  { tab: "general", Section: SettingsGeneral },
  { tab: "general", Section: SettingsSymbols },
  { tab: "events", Section: SettingsEvents },
  { tab: "peb-normalize", Section: SettingsPebNormalize },
  { tab: "sandbox", Section: SettingsSandbox },
  { tab: "diagnostics", Section: SettingsDiagnostics },
  { tab: "keybindings", Section: SettingsKeybindings },
];

/** A tab the platform lacks (`requires`) is not offered, and neither are its sections. */
const TABS: { value: string; label: string; requires?: keyof PlatformFeatures }[] = [
  { value: "all", label: "All" },
  { value: "general", label: "General" },
  { value: "keybindings", label: "Keyboard Shortcuts" },
  { value: "events", label: "Events and Exceptions" },
  { value: "peb-normalize", label: "PEB Normalization", requires: "peb_normalize" },
  { value: "sandbox", label: "Sandbox", requires: "sandbox" },
  { value: "diagnostics", label: "Diagnostics" },
];

const isTab = (value: string | null): value is string => TABS.some((t) => t.value === value);

export default function Settings() {
  const [searchParams] = useSearchParams();
  const urlTab = searchParams.get("tab");

  const [searchQuery, setSearchQuery] = useState("");
  const { features } = usePlatform();
  const [tab, setTab] = useState(isTab(urlTab) ? urlTab : "all");

  // Sync tab with URL search params (e.g. navigating via command palette)
  useEffect(() => {
    if (isTab(urlTab)) setTab(urlTab);
  }, [urlTab]);

  // A search looks through every section, whichever tab it was typed in.
  const handleSearchChange = (value: string) => {
    setSearchQuery(value);
    if (value && tab !== "all") {
      setTab("all");
    }
  };

  const tabs = TABS.filter((t) => !t.requires || features[t.requires]);
  const shown = (sectionTab: string) => (tab === "all" ? tabs.some((t) => t.value === sectionTab) : sectionTab === tab);

  return (
    <Page scroll={false} container={false} className="overflow-hidden">
      {/* Fixed head: title, search and the section tabs, on the column the
          settings themselves are laid out on. */}
      <div className="shrink-0 border-b">
        <div className="mx-auto w-full max-w-3xl px-6 pt-6 pb-3 space-y-3">
          <h1 className="text-2xl font-bold">Settings</h1>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search settings..."
              value={searchQuery}
              onChange={(e) => handleSearchChange(e.target.value)}
              className="pl-9"
            />
          </div>
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList className="h-auto max-w-full flex-wrap justify-start">
              {tabs.map((t) => (
                <TabsTrigger key={t.value} value={t.value} className="flex-none">{t.label}</TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
      </div>

      <ScrollArea className="flex-1 min-h-0">
        {/* Sections render nothing when the search leaves them empty; the
            empty state below shows through when all of them do. */}
        <div className="mx-auto w-full max-w-3xl px-6 py-6 space-y-8" data-testid="settings-sections">
          {/* Keyed by place in SECTIONS, so a section that stays on screen
              across a tab switch keeps its state. */}
          {SECTIONS.map(({ tab: sectionTab, Section }, i) => shown(sectionTab) && <Section key={i} searchQuery={searchQuery} />)}
          <div className="hidden first:block">
            <EmptyState
              icon={<SearchX className={STATE_ICON_CLASS} />}
              title="No settings match"
              subtitle={`Nothing is called "${searchQuery}"`}
            />
          </div>
        </div>
      </ScrollArea>
    </Page>
  );
}
