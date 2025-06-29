import DockLayout from "rc-dock";
import "rc-dock/dist/rc-dock.css";
import { useTheme } from "next-themes";

const defaultLayout = {
  dockbox: {
    mode: "horizontal" as const,
    children: [
      {
        tabs: [{ id: "tab1", title: "tab1", content: <div>Hello World 1</div> }],
      },
      {
        tabs: [{ id: "tab2", title: "tab2", content: <div>Hello World 2</div> }],
      },
    ],
  },
};

export default function RcDock() {
  const { resolvedTheme } = useTheme();

  return (
    <DockLayout
      key={resolvedTheme}
      defaultLayout={defaultLayout}
      style={{
        position: "absolute",
        left: 10,
        top: 80, // Adjust top to be below the header
        right: 10,
        bottom: 10,
      }}
    />
  );
} 