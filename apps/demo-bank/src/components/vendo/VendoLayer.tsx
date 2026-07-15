"use client";

import { useEffect } from "react";
import { useVendoOverlay } from "@vendoai/ui";
import { VendoOverlay } from "@vendoai/ui/chrome";

async function resetDemo(): Promise<void> {
  try {
    await fetch("/api/demo/reset", { method: "POST" });
  } finally {
    window.location.href = "/";
  }
}

export function VendoLayer() {
  // ENG-220: Cmd/Ctrl+K drives the supported programmatic overlay API instead
  // of DOM-poking the launcher; the launcher itself is the ui package's
  // default fixed bottom-right pill.
  const overlay = useVendoOverlay();
  const { toggle } = overlay;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.shiftKey && event.code === "Period") {
        event.preventDefault();
        void resetDemo();
        return;
      }
      if (!event.shiftKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        toggle();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [toggle]);

  return (
    <>
      <VendoOverlay {...overlay.overlayProps} />
      {/* VENDO-MIGRATION: 08-ui's frozen overlay does not expose custom
          greetings or suggestion chips; Cmd/Ctrl+K behavior remains intact. */}
      {/* VENDO-MIGRATION: connectors remain available to the server-side agent,
          but 08-ui has no integration/OAuth rail or ConnectCard surface. */}
    </>
  );
}
