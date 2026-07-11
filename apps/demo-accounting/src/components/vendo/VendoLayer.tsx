"use client";

/**
 * The Vendo layer dropped over Cadence. A single client island that owns the
 * shared agent session and the Cmd/Ctrl+K overlay. Mounted once in the root
 * layout wrapping the app UI.
 *
 * No persistent launcher: Vendo is invisible until summoned with Cmd/Ctrl+K.
 * Stage shortcut: Cmd/Ctrl+Shift+Period resets the demo.
 */
import { useEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { VendoOverlay } from "@vendoai/shell";
import { VendoRoot } from "./VendoRoot";

const SUGGESTIONS = [
  "Which clients are still missing documents?",
];

async function resetDemo(): Promise<void> {
  try {
    await fetch("/api/demo/reset", { method: "POST" });
  } catch {
    /* reload anyway — server may already be pristine */
  }
  window.location.href = "/";
}

export function VendoLayer({ children }: { children: ReactNode }) {
  const [overlayOpen, setOverlayOpen] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey) return;
      if (e.code === "Period") {
        e.preventDefault();
        void resetDemo();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // The /assistant page owns its own full-page surface; the floating overlay
  // stays out of its way (one summonable chat per screen). The provider still
  // wraps the page so the shared agent context remains available.
  const floatingSurfaces = !pathname?.startsWith("/assistant");

  return (
    <VendoRoot>
      {children}
      {floatingSurfaces && (
        /* The only floating surface: invisible until summoned with Cmd/Ctrl+K. */
        <VendoOverlay
          shortcutKey="k"
          launcherLabel="Ask Vendo"
          greeting="Ask Vendo anything"
          suggestions={SUGGESTIONS}
          open={overlayOpen}
          onOpenChange={setOverlayOpen}
        />
      )}
    </VendoRoot>
  );
}
