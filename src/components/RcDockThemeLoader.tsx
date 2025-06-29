import { useEffect } from "react";
import { useTheme } from "next-themes";

const RcDockThemeLoader = () => {
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    let styleLink = document.getElementById("rc-dock-styles") as HTMLLinkElement;
    if (!styleLink) {
      styleLink = document.createElement("link");
      styleLink.id = "rc-dock-styles";
      styleLink.rel = "stylesheet";
      document.head.appendChild(styleLink);
    }

    if (resolvedTheme === "dark") {
      import("rc-dock/dist/rc-dock-dark.css?url").then((url) => {
        styleLink.href = url.default;
      });
    } else {
      import("rc-dock/dist/rc-dock.css?url").then((url) => {
        styleLink.href = url.default;
      });
    }
  }, [resolvedTheme]);

  return null;
};

export default RcDockThemeLoader; 