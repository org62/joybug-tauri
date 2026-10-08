import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { PlatformInfo, WINDOWS_PLATFORM } from "@/contexts/PlatformContext";

export { usePlatform, isLaunchableFile, launchablePattern, imageDropPattern } from "@/contexts/PlatformContext";

/**
 * Resolve the host platform once per app lifetime. `null` until the backend
 * answers; PlatformProvider renders nothing route-level until then so no
 * Windows-only control flashes on Linux. A failed call falls back to the
 * Windows feature set — the pre-existing behaviour.
 */
export function usePlatformInfo(): PlatformInfo | null {
  const [info, setInfo] = useState<PlatformInfo | null>(null);
  useEffect(() => {
    let cancelled = false;
    invoke<PlatformInfo>("get_platform_info")
      .then((p) => { if (!cancelled) setInfo(p); })
      .catch((e) => {
        console.error("Failed to read platform info:", e);
        if (!cancelled) setInfo(WINDOWS_PLATFORM);
      });
    return () => { cancelled = true; };
  }, []);
  return info;
}
