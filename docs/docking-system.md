# Reusable Docking Windows Layout System

This document explains how to use the new reusable docking windows layout system for creating flexible, customizable UI layouts with tabbed panels.

## Overview

The docking system consists of three main parts:

1. **`useDocking` hook** - Core logic for layout management
2. **`DockingLayout` component** - Reusable wrapper component  
3. **Configuration utilities** - Predefined layouts and tab definitions

## Quick Start

### Using a Predefined Configuration

```tsx
import React from "react";
import DockingLayout, { DockingLayoutRef } from "@/components/DockingLayout";
import { DefaultDockingConfig } from "@/lib/dockingConfigs";

export default function MyPage() {
  const dockingRef = React.useRef<DockingLayoutRef>(null);

  return (
    <div style={{ position: "relative", height: "100vh" }}>
      <DockingLayout
        ref={dockingRef}
        {...DefaultDockingConfig}
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          right: 0,
          bottom: 0,
        }}
      />
    </div>
  );
}
```

### Controlling the Layout

```tsx
// Add a new tab
dockingRef.current?.addTab();

// Reset to initial layout
dockingRef.current?.resetLayout();

// Toggle a specific tab (show if hidden, activate if shown)
dockingRef.current?.toggleTab("disassembly");
```

## Available Configurations

### DefaultDockingConfig
- Basic 4-tab layout with sample content
- Storage prefix: "default-dock"
- Includes: tab1, tab2, tab3, tab4, disassembly

### DebuggerDockingConfig
- Professional debugger layout
- Storage prefix: "debugger-dock"
- Includes: disassembly, registers, memory, console, stack
- Optimized panel sizes for debugging workflow

## Examples

See the following files for complete examples:
- `src/pages/RcDock.tsx` - Basic usage with default configuration
- `src/pages/DebuggerExample.tsx` - Advanced usage with debugger configuration

## Migration Benefits

The new system reduces hundreds of lines of boilerplate to just a few lines while maintaining full functionality and adding persistence. 