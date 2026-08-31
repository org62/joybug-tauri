import { open } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { FolderPlus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { guestPathForMount, type SandboxMount } from "@/lib/sandbox";

interface SandboxMountsEditorProps {
  mounts: SandboxMount[];
  onChange: (mounts: SandboxMount[]) => void;
}

/**
 * Add/remove host folders mapped into a Windows Sandbox. Each row shows the host
 * path, the guest path it lands at (`C:\mounts\<basename>`), and a read-only
 * toggle. The target executable must live under one of these mounts.
 */
export function SandboxMountsEditor({ mounts, onChange }: SandboxMountsEditorProps) {
  const addFolder = async () => {
    try {
      const selected = await open({ directory: true, multiple: false });
      if (typeof selected === "string" && selected) {
        if (mounts.some((m) => m.host_path.toLowerCase() === selected.toLowerCase())) return;
        onChange([...mounts, { host_path: selected, read_only: true }]);
      }
    } catch (error) {
      console.error("Failed to open folder dialog:", error);
      toast.error(`Failed to open folder dialog: ${error}`);
    }
  };

  const removeAt = (index: number) => {
    onChange(mounts.filter((_, i) => i !== index));
  };

  const setReadOnly = (index: number, readOnly: boolean) => {
    onChange(mounts.map((m, i) => (i === index ? { ...m, read_only: readOnly } : m)));
  };

  return (
    <div className="space-y-1.5">
      {mounts.length > 0 && (
        <div className="rounded-md border divide-y">
          {mounts.map((m, i) => (
            <div key={`${m.host_path}-${i}`} className="flex items-center gap-2 px-2 py-1.5 text-xs">
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono" title={m.host_path}>
                  {m.host_path}
                </div>
                <div className="truncate text-muted-foreground" title={guestPathForMount(m.host_path, mounts.slice(0, i))}>
                  → {guestPathForMount(m.host_path, mounts.slice(0, i))}
                </div>
              </div>
              <label className="flex items-center gap-1 shrink-0 text-muted-foreground">
                <Switch size="xs" checked={m.read_only} onCheckedChange={(v) => setReadOnly(i, v)} />
                RO
              </label>
              <Button
                size="icon-xs"
                variant="ghost"
                onClick={() => removeAt(i)}
                title="Remove mount"
                type="button"
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}
      <Button size="xs" variant="outline" onClick={addFolder} type="button">
        <FolderPlus className="size-3.5 mr-1" />
        Add folder
      </Button>
    </div>
  );
}
