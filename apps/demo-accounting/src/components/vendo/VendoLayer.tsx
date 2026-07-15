"use client";

import { useEffect, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { useVendoOverlay } from "@vendoai/ui";
import { VendoOverlay } from "@vendoai/ui/chrome";
import { VendoRoot } from "./VendoRoot";

async function resetDemo(): Promise<void> {
  try {
    await fetch("/api/demo/reset", { method: "POST" });
  } finally {
    window.location.href = "/";
  }
}

export function VendoLayer({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const floatingSurface = !pathname?.startsWith("/assistant");
  // ENG-220: Cmd/Ctrl+K drives the supported programmatic overlay API instead
  // of DOM-poking the launcher; the launcher itself is the ui package's
  // default fixed bottom-right pill.
  const overlay = useVendoOverlay();
  const { toggle, close } = overlay;

  // The overlay unmounts on /assistant (the page surface takes over) — drop
  // any open state with it so navigating back never re-shows the dialog
  // without user intent.
  useEffect(() => {
    if (!floatingSurface) close();
  }, [floatingSurface, close]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.shiftKey && event.code === "Period") {
        event.preventDefault();
        void resetDemo();
        return;
      }
      if (!event.shiftKey && event.key.toLowerCase() === "k" && floatingSurface) {
        event.preventDefault();
        toggle();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [floatingSurface, toggle]);

  return (
    <VendoRoot>
      {children}
      {floatingSurface ? <VendoOverlay {...overlay.overlayProps} /> : null}
      {/* VENDO-MIGRATION: 08-ui's frozen overlay does not expose custom
          greetings or suggestion chips; Cmd/Ctrl+K behavior remains intact. */}
    </VendoRoot>
  );
}
