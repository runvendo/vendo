"use client";

import { useEffect, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useVendoOverlay } from "@vendoai/ui";
import { VendoOverlay, VendoPalette, type VendoCommand } from "@vendoai/ui/chrome";
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
  const { toggle, close, open } = overlay;
  const router = useRouter();

  // ENG-230: route ⌘J palette commands. Opening the agent or a new conversation
  // uses the overlay; showing activity jumps to the shipped workspace.
  const onCommand = (command: VendoCommand) => {
    if (command.kind === "show-activity") router.push("/vendo/workspace");
    else open();
  };

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
      {/* ENG-230: the command palette surface, mounted app-wide. Distinct
          chord (Cmd/Ctrl+J) so it never fights the overlay's own ⌘K toggle. */}
      <VendoPalette
        hotkey={(event) => (event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === "j"}
        onCommand={onCommand}
      />
    </VendoRoot>
  );
}
