import React from "react";
import { LayoutData, TabData } from "rc-dock";
import { DockingConfig } from "@/hooks/useDocking";
import { RegisterView as StaticRegisterView, SerializableThreadContext } from "@/components/RegisterView";

const mockContext: SerializableThreadContext = {
  arch: "X64",
  rax: "0x0", rbx: "0x0", rcx: "0x0", rdx: "0x0",
  rsi: "0x0", rdi: "0x0", rbp: "0x0", rsp: "0x0",
  rip: "0x0",
  r8: "0x0", r9: "0x0", r10: "0x0", r11: "0x0",
  r12: "0x0", r13: "0x0", r14: "0x0", r15: "0x0",
  eflags: "0x0",
};

export const DebuggerDockingConfig: DockingConfig = {
  storagePrefix: "debugger-dock",
  initialLayout: {
    dockbox: {
      mode: "horizontal" as const,
      children: [
        {
          mode: "vertical" as const,
          size: 80,
          children: [
            {
              tabs: [{ id: "modules" }],
              activeId: "modules",
            },
            {
              tabs: [{ id: "threads" }],
              activeId: "threads",
            },
          ],
        },
        {
          tabs: [{ id: "disassembly" }],
          activeId: "disassembly",
        },
        {
          mode: "vertical" as const,
          size: 80,
          children: [
            {
              tabs: [{ id: "registers" }],
              activeId: "registers",
            },
            {
              tabs: [{ id: "callstack" }],
              activeId: "callstack",
            },
          ],
        },
      ],
    },
  } as LayoutData,
  initialTabContents: {
    disassembly: { id: "disassembly", title: "Disassembly", content: <div>Disassembly placeholder</div> },
    registers: { id: "registers", title: "Registers", content: <StaticRegisterView context={mockContext} /> },
    modules: { id: "modules", title: "Modules", content: <div>Modules placeholder</div> },
    threads: { id: "threads", title: "Threads", content: <div>Threads placeholder</div> },
    callstack: { id: "callstack", title: "Call Stack", content: <div>Call Stack placeholder</div> },
  } as { [key: string]: TabData },
  tabContentMap: {
    registers: <StaticRegisterView context={mockContext} />,
  } as { [key: string]: React.ReactElement },
}; 