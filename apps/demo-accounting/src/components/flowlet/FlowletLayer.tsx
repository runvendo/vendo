"use client";

/**
 * The Flowlet layer dropped over Cadence. A single client island that owns the
 * shared agent session, the Cmd/Ctrl+K overlay, and the scheduler heartbeat.
 * Mounted once in the root layout so it floats above the untouched app UI —
 * the "we dropped in one layer" thesis, literally.
 *
 * No persistent launcher: Flowlet is invisible until summoned with Cmd/Ctrl+K.
 * Stage shortcut: Cmd/Ctrl+Shift+Period resets the demo (store + automations).
 */
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { FlowletOverlay } from "@flowlet/shell";
import { FlowletRoot } from "./FlowletRoot";

const SUGGESTIONS = [
  "Which clients are still missing documents?",
  "every morning, email any clients missing docs. If anyone is within 3 days of a deadline, book a call with them on my calendar",
];

/** Ping the scheduler so due cron automations fire — the in-process scheduler
 *  owns no timer of its own (a Next dev singleton must not leak intervals). */
function useSchedulerHeartbeat(intervalMs = 30_000) {
  useEffect(() => {
    const tick = () => void fetch("/api/flowlet/tick", { method: "POST" }).catch(() => {});
    tick();
    const id = setInterval(tick, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
}

async function resetDemo(): Promise<void> {
  try {
    await fetch("/api/demo/reset", { method: "POST" });
  } catch {
    /* reload anyway — server may already be pristine */
  }
  window.location.href = "/";
}

export function FlowletLayer() {
  const [overlayOpen, setOverlayOpen] = useState(false);
  const pathname = usePathname();
  useSchedulerHeartbeat();

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

  // The /assistant page owns its own full-page surface; the overlay stays out
  // of its way (one summonable chat per screen).
  if (pathname?.startsWith("/assistant")) return null;

  return (
    <FlowletRoot>
      {/* The only floating surface: invisible until summoned with Cmd/Ctrl+K. */}
      <FlowletOverlay
        shortcutKey="k"
        launcherLabel="Ask Vendo"
        greeting="Ask Vendo anything"
        suggestions={SUGGESTIONS}
        open={overlayOpen}
        onOpenChange={setOverlayOpen}
      />
    </FlowletRoot>
  );
}
