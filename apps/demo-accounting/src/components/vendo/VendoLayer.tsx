"use client";

/**
 * The Vendo layer dropped over Cadence. A single client island that owns the
 * shared agent session, the Cmd/Ctrl+K overlay, automation toasts, and the
 * scheduler heartbeat. Mounted once in the root layout WRAPPING the app UI —
 * page content must live inside the provider so VendoRemix wrappers reach
 * the same registry/overlay (2026-07-04 spec).
 *
 * No persistent launcher: Vendo is invisible until summoned with Cmd/Ctrl+K.
 * Stage shortcut: Cmd/Ctrl+Shift+Period resets the demo (store + automations).
 */
import { useEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { VendoOverlay, VendoToasts } from "@vendoai/shell";
import { VendoRoot } from "./VendoRoot";

const SUGGESTIONS = [
  "Which clients are still missing documents?",
  "every morning, email any clients missing docs. If anyone is within 3 days of a deadline, book a call with them on my calendar",
];

/** Ping the scheduler so due cron automations fire — the in-process scheduler
 *  owns no timer of its own (a Next dev singleton must not leak intervals). */
function useSchedulerHeartbeat(intervalMs = 30_000) {
  useEffect(() => {
    const tick = () => void fetch("/api/vendo/tick", { method: "POST" }).catch(() => {});
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

export function VendoLayer({ children }: { children: ReactNode }) {
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

  // The /assistant page owns its own full-page surface; the floating overlay
  // stays out of its way (one summonable chat per screen). The provider still
  // wraps the page so remix wrappers and toasts keep working there.
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
      {/* Automation deliveries: completions + approvals (2026-07-04 spec). */}
      <VendoToasts placement="bottom-right" namespace="cadence-demo" />
    </VendoRoot>
  );
}
