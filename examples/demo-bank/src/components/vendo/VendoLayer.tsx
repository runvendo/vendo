"use client";

import { useEffect } from "react";
import { withBasePath } from "@/lib/base-path";
import { useVendoOverlay } from "@vendoai/ui";
import { VendoOverlay, VendoPalette, VendoThread, type VendoCommand, type VendoThreadProps } from "@vendoai/ui/chrome";
import { MapleMark } from "@/components/ui/maple-mark";
import { VendoWorkbench } from "@/components/vendo/workbench/VendoWorkbench";
import { mapleScenarios } from "@/vendo/scenarios";

/** The overlay's thread with the Maple scenario cards on the empty landing.
 *  Module-scope so the component identity is stable across VendoLayer renders.
 *  discoverability="quiet" stands the fire-once greeting-as-tutorial down so
 *  the scripted-demo landing is the four scenario cards, identically on every
 *  machine and after every reset. */
function MapleThread(props: VendoThreadProps) {
  return <VendoThread {...props} suggestions={mapleScenarios} discoverability="quiet" />;
}

async function resetDemo(): Promise<void> {
  try {
    await fetch(withBasePath("/api/demo/reset"), { method: "POST" });
  } finally {
    window.location.href = withBasePath("/");
  }
}

export function VendoLayer() {
  // ENG-220: Cmd/Ctrl+K drives the supported programmatic overlay API and
  // stays as the power path. demo-refresh Part 4: the branded launcher pill
  // ("Ask Maple" + the Maple mark) is the visible front door.
  const overlay = useVendoOverlay();
  const { toggle, open } = overlay;

  // Every ⌘K palette command opens the overlay. "Show activity" used to route
  // to the full-page workspace; that surface is gone, and Maple mounts no
  // replacement, so the command falls back to the overlay like the rest.
  const onCommand = (_command: VendoCommand) => open();

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
      <VendoOverlay
        {...overlay.overlayProps}
        launcher={{
          position: "bottom-right",
          label: "Ask Maple",
          icon: <MapleMark className="h-3.5 w-3.5" />,
        }}
        thread={MapleThread}
      />
      {/* ENG-230: the command palette surface, mounted app-wide. Distinct
          chord (Cmd/Ctrl+J) so it never fights the overlay's own ⌘K toggle. */}
      <VendoPalette
        hotkey={(event) => (event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === "j"}
        onCommand={onCommand}
      />
      {/* The harness workbench: dev-only diagnostics, docked beside the
          overlay. Renders nothing outside `next dev`. */}
      <VendoWorkbench />
    </>
  );
}
