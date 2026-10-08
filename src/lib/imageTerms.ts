/**
 * How the UI names the executable image format and its artifacts on the
 * target platform: "PE Viewer" / "DLL" / "PDB" on Windows, "ELF Viewer" /
 * "shared object" / "debug file" on Linux. The target OS is the host OS
 * (every session is local), so callers pass `usePlatform().os`.
 */
export interface ImageTerms {
  /** The format's name: "PE" / "ELF". */
  format: "PE" | "ELF";
  /** Name of the offline image viewer page and the session tab. */
  viewer: string;
  /** A loaded library: "DLL" / "shared object". */
  module: string;
  /** A separate debug-info file: "PDB" / "debug file". */
  debugFile: string;
  /** File-picker filter for that debug file. */
  debugFileFilter: { name: string; extensions: string[] };
  /** The symbols a module yields on its own, without a debug file. */
  exportsOnly: string;
  noDebugFile: string;
}

const WINDOWS: ImageTerms = {
  format: "PE",
  viewer: "PE Viewer",
  module: "DLL",
  debugFile: "PDB",
  debugFileFilter: { name: "PDB Files", extensions: ["pdb"] },
  exportsOnly: "PE exports only",
  noDebugFile: "no PDB available",
};

const ELF: ImageTerms = {
  format: "ELF",
  viewer: "ELF Viewer",
  module: "shared object",
  debugFile: "debug file",
  debugFileFilter: { name: "ELF debug files", extensions: ["debug", "so"] },
  exportsOnly: "dynamic symbols only",
  noDebugFile: "no debug file available",
};

export function imageTerms(os: string): ImageTerms {
  return os === "windows" ? WINDOWS : ELF;
}
