import { createContext, useContext } from "react";
import { IMAGE_FILE_PATTERN } from "@/hooks/useFileDrop";

/** Mirrors the Rust `PlatformFeatures` (commands/platform.rs). */
export interface PlatformFeatures {
  sandbox: boolean;
  etw: boolean;
  jit: boolean;
  handles: boolean;
  minidump: boolean;
  peb_normalize: boolean;
}

/** Mirrors the Rust `PlatformInfo` (commands/platform.rs). */
export interface PlatformInfo {
  os: string;
  features: PlatformFeatures;
  default_launch_command: string;
  exe_extensions: string[];
}

/**
 * What the backend assumes until `get_platform_info` answers. Windows is the
 * historical default: every surface exists there, so a page rendered against
 * this before the real answer lands shows nothing it would later have to hide
 * on Windows — and PlatformProvider holds routes back until the answer is in,
 * so on Linux nothing Windows-only flashes either.
 */
export const WINDOWS_PLATFORM: PlatformInfo = {
  os: "windows",
  features: { sandbox: true, etw: true, jit: true, handles: true, minidump: true, peb_normalize: true },
  default_launch_command: "cmd.exe /c echo Hello World!",
  exe_extensions: ["exe", "com", "bat", "cmd"],
};

export const PlatformContext = createContext<PlatformInfo>(WINDOWS_PLATFORM);

/** The host platform the backend runs on and the features it can serve. */
export function usePlatform(): PlatformInfo {
  return useContext(PlatformContext);
}

/**
 * Drop filter for a launchable debug target on this platform. Windows
 * identifies executables by extension; Unix has no such convention, so any
 * dropped file is offered for launch there (the OS refuses the rest).
 */
export function launchablePattern(info: PlatformInfo): RegExp {
  if (info.exe_extensions.length === 0) return /./;
  return new RegExp(`\\.(${info.exe_extensions.join("|")})$`, "i");
}

/** Whether `path` names something this platform can launch as a debug target. */
export function isLaunchableFile(path: string, info: PlatformInfo): boolean {
  return launchablePattern(info).test(path);
}

/**
 * Drop filter for the offline image viewer: the PE/ELF extensions where
 * executables carry one, any file where they don't (the backend's magic check
 * decides).
 */
export function imageDropPattern(info: PlatformInfo): RegExp {
  return info.exe_extensions.length === 0 ? /./ : IMAGE_FILE_PATTERN;
}
