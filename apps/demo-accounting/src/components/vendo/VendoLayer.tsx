"use client";

import { useEffect, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useVendoOverlay } from "@vendoai/ui";
import { VendoOverlay, VendoPalette, VendoThread, type VendoCommand, type VendoThreadProps } from "@vendoai/ui/chrome";
import { CadenceMark } from "@/components/brand";
import { cadenceScenarios } from "@/vendo/scenarios";
import { VendoRoot } from "./VendoRoot";

/** The overlay's thread with the Cadence scenario cards on the empty landing.
 *  Module-scope so the component identity is stable across VendoLayer renders. */
function CadenceThread(props: VendoThreadProps) {
  return <VendoThread {...props} suggestions={cadenceScenarios} />;
}

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
  // ENG-220: Cmd/Ctrl+K drives the supported programmatic overlay API and
  // stays as the power path. demo-refresh Part 4: the launcher pill is branded
  // ("Ask Cadence" + the brand's green full stop) as the visible front door;
  // the sidebar link keeps the full-page route reachable under the same name.
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
      {floatingSurface ? (
        <VendoOverlay
          {...overlay.overlayProps}
          launcher={{
            position: "bottom-right",
            label: "Ask Cadence",
            icon: <CadenceMark className="h-3.5 w-3.5" />,
          }}
          thread={CadenceThread}
        />
      ) : null}
      {/* ENG-230: the command palette surface, mounted app-wide. Distinct
          chord (Cmd/Ctrl+J) so it never fights the overlay's own ⌘K toggle. */}
      <VendoPalette
        hotkey={(event) => (event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === "j"}
        onCommand={onCommand}
      />
    </VendoRoot>
  );
}
