import React from "react";
import { LayoutData } from "rc-dock";
import { DockingConfig } from "@/hooks/useDocking";
import type { HomePanelId } from "@/lib/sessionTabs";
import {
  RegisterView as StaticRegisterView,
  SerializableThreadContext,
  X64_REGISTERS,
  X64_XMM_REGISTERS,
  X64_DEBUG_REGISTERS,
} from "@/components/RegisterView";

// Zero-valued x64 context for the static tab preview, derived from the
// register defs so it never drifts when registers are added.
const mockContext = {
  arch: "X64",
  ...Object.fromEntries(
    [...X64_REGISTERS, ...X64_XMM_REGISTERS, ...X64_DEBUG_REGISTERS].map((d) => [d.field, "0x0"]),
  ),
} as SerializableThreadContext;

// SessionDocked builds its own storage prefix and tab contents from
// SESSION_TAB_DEFS; this module owns only the default layout and the static
// registers preview.
export const DebuggerDockingConfig = {
  // Reset Layout restores this bare-minimum set — a usable debugger, not all 20
  // tabs stacked in one panel. Everything else opens on demand into its home
  // panel (see SessionTabDef.home). The panel ids are what `home` resolves to;
  // `satisfies HomePanelId` makes renaming one here without updating
  // lib/sessionTabs.tsx a compile error.
  initialLayout: {
    dockbox: {
      mode: "horizontal" as const,
      children: [
        {
          mode: "vertical" as const,
          size: 80,
          children: [
            { id: "panel-left-top" satisfies HomePanelId, tabs: [{ id: "modules" }], activeId: "modules" },
            { id: "panel-left-bottom" satisfies HomePanelId, tabs: [{ id: "threads" }], activeId: "threads" },
          ],
        },
        {
          id: "panel-center" satisfies HomePanelId,
          tabs: [{ id: "disassembly" }, { id: "memory" }],
          activeId: "disassembly",
        },
        {
          mode: "vertical" as const,
          size: 80,
          children: [
            { id: "panel-right-top" satisfies HomePanelId, tabs: [{ id: "registers" }], activeId: "registers" },
            { id: "panel-right-bottom" satisfies HomePanelId, tabs: [{ id: "callstack" }], activeId: "callstack" },
          ],
        },
      ],
    },
  } as LayoutData,
  tabContentMap: {
    registers: <StaticRegisterView context={mockContext} />,
  } as { [key: string]: React.ReactElement },
} satisfies Pick<DockingConfig, "initialLayout" | "tabContentMap">;
