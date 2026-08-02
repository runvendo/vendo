"use client";

import { useEffect } from "react";
import { withBasePath } from "@/lib/base-path";
import { useRouter } from "next/navigation";
import { useVendoOverlay } from "@vendoai/ui";
import { VendoOverlay, VendoPalette, VendoThread, type VendoCommand, type VendoThreadProps } from "@vendoai/ui/chrome";
import { MapleMark } from "@/components/ui/maple-mark";
import { useTryThisChips } from "@/components/vendo/use-try-this-chips";
import { mapleScenarios } from "@/vendo/scenarios";

/** The overlay's thread with the Maple scenario cards on the empty landing,
 *  plus the pre-generated "try this" pill chips one tier below (demo-hygiene;
 *  absent while the chip cache is empty).
 *  Module-scope so the component identity is stable across VendoLayer renders.
 *  discoverability="quiet" stands the fire-once greeting-as-tutorial down so
 *  the scripted-demo landing is the four scenario cards, identically on every
 *  machine and after every reset. */
function MapleThread(props: VendoThreadProps) {
  const chips = useTryThisChips();
  // Empty cache keeps the original mapleScenarios reference (and no extra
  // render — see useTryThisChips), matching the full page's landing contract.
  const suggestions = chips.length === 0 ? mapleScenarios : [...mapleScenarios, ...chips];
  return <VendoThread {...props} suggestions={suggestions} discoverability="quiet" />;
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
  // ("Ask Maple" + the Maple mark) is the visible front door; the sidebar
  // link keeps the full-page route reachable.
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
    </>
  );
}
