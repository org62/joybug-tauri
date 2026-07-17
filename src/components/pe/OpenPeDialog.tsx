import { useState } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { FolderOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";

interface OpenPeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the chosen file, optional load base (hex), and optional PDB path. */
  onConfirm: (path: string, base: string | null, pdbPath: string | null) => void;
}

/**
 * "Open PE" dialog: pick a file, optionally override the load base (defaults to
 * the file's ImageBase) and point at a specific PDB. A same-named PDB next to the
 * file auto-loads even when no PDB is given.
 */
export const OpenPeDialog: React.FC<OpenPeDialogProps> = ({ open, onOpenChange, onConfirm }) => {
  const [path, setPath] = useState("");
  const [base, setBase] = useState("");
  const [pdb, setPdb] = useState("");

  const browseFile = async () => {
    const sel = await openFileDialog({
      multiple: false, directory: false,
      filters: [
        { name: "PE files", extensions: ["exe", "dll", "sys", "efi", "ocx", "cpl", "scr"] },
        { name: "All Files", extensions: ["*"] },
      ],
    });
    if (typeof sel === "string") setPath(sel);
  };
  const browsePdb = async () => {
    const sel = await openFileDialog({ multiple: false, directory: false, filters: [{ name: "PDB", extensions: ["pdb"] }] });
    if (typeof sel === "string") setPdb(sel);
  };

  const confirm = () => {
    if (!path) return;
    onConfirm(path, base.trim() || null, pdb.trim() || null);
    onOpenChange(false);
    setBase(""); setPdb("");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Open PE File</DialogTitle>
          <DialogDescription>Load an executable or DLL. Base and PDB are optional.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label className="text-xs">File</Label>
            <div className="flex gap-2">
              <Input value={path} onChange={(e) => setPath(e.target.value)} placeholder="Path to .exe / .dll" className="flex-1 font-mono text-xs" />
              <Button variant="outline" size="sm" onClick={browseFile}><FolderOpen className="h-4 w-4" /></Button>
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Load base (optional)</Label>
            <Input value={base} onChange={(e) => setBase(e.target.value)} placeholder="default: file ImageBase (e.g. 0x140000000)" className="font-mono text-xs" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">PDB (optional)</Label>
            <div className="flex gap-2">
              <Input value={pdb} onChange={(e) => setPdb(e.target.value)} placeholder="auto: same-named PDB next to the file" className="flex-1 font-mono text-xs" />
              <Button variant="outline" size="sm" onClick={browsePdb}><FolderOpen className="h-4 w-4" /></Button>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={confirm} disabled={!path}>Open</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
