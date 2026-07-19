"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useVendoOverlay } from "@vendoai/ui";
import { VendoOverlay, VendoPalette, type VendoCommand } from "@vendoai/ui/chrome";

async function resetDemo(): Promise<void> {
  try {
    await fetch("/api/demo/reset", { method: "POST" });
  } finally {
    window.location.href = "/";
  }
}

export function VendoLayer() {
  // ENG-220: Cmd/Ctrl+K drives the supported programmatic overlay API instead
  // of DOM-poking the launcher. Maple keeps its dock as the visible Vendo
  // surface, so the built-in launcher is suppressed the supported way
  // (launcher="none") instead of the old display:none CSS hack.
  const overlay = useVendoOverlay();
  const { toggle, open } = overlay;
  const router = useRouter();

  // ENG-230: route ⌘K palette commands. Opening the agent or a new conversation
  // uses the overlay; showing activity jumps to the shipped workspace.
  const onCommand = (command: VendoCommand) => {
    if (command.kind === "show-activity") router.push("/vendo/workspace");
    else open();
  };

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
      <VendoOverlay {...overlay.overlayProps} launcher="none" />
      {/* ENG-230: the command palette surface, mounted app-wide. Distinct
          chord (Cmd/Ctrl+J) so it never fights the overlay's own ⌘K toggle. */}
      <VendoPalette
        hotkey={(event) => (event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === "j"}
        onCommand={onCommand}
      />
    </>
  );
}
