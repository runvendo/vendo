"use client";

import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { VendoRoot as UmbrellaVendoRoot } from "@vendoai/vendo/react";
import { ScriptedTransport, type DirectorScript, type ToolMetaMap } from "@vendoai/ui";
import { cadenceRegistry } from "@/vendo/registry";
import { cadenceTheme } from "@/vendo/theme";
import { cadenceRealtimeVoiceDriver } from "./voice-realtime";

/**
 * ENG-216 humanization seam: Cadence describes its own tools so build beats
 * and approvals speak in the product's voice ("Reading your deadlines…"
 * instead of a prettified slug). Additive — anything unlisted falls back to
 * the chrome's formatting.
 */
const cadenceToolMeta: ToolMetaMap = {
  host_listDeadlines: { label: "Reading your deadlines" },
  host_listClients: { label: "Reading your clients" },
  host_listActivity: { label: "Reading recent activity" },
  host_sendClientMessage: { label: "Messaging your client" },
  vendo_apps_create: { label: "Building your view" },
  vendo_apps_edit: { label: "Refining your view" },
  vendo_apps_fork: { label: "Remixing from Cadence" },
  vendo_automations_enable: { label: "Wiring the schedule" },
  slack_SLACK_SEND_MESSAGE: { label: "Post to #team in Slack" },
};

/**
 * Director mode (demo capture tooling, never a default): with
 * `?vendodirector=1` (or `localStorage["vendo-director"] = "1"`), threads
 * replay the authored script from `public/vendo-director/script.json` through
 * the REAL surfaces at scripted pacing instead of calling the agent. Record a
 * live take by setting `globalThis.__vendoDirectorRecord = true` before a
 * run, then save `__vendoDirectorRecording` as the script's cues.
 */
const noopSubscribe = () => () => {};
/** Client-only flag, hydration-safe: false on the server, real value on the client. */
function useDirectorRequested(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () =>
      new URLSearchParams(window.location.search).get("vendodirector") === "1" ||
      window.localStorage.getItem("vendo-director") === "1",
    () => false,
  );
}

function useDirectorTransport(): { enabled: boolean; transport?: ScriptedTransport } {
  const enabled = useDirectorRequested();
  const [transport, setTransport] = useState<ScriptedTransport>();
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    // Cache-busted: a stale cached script replays old component sources.
    void fetch(`/vendo-director/script.json?v=${Date.now()}`, { cache: "no-store" })
      .then(response => (response.ok ? (response.json() as Promise<DirectorScript>) : undefined))
      .then(script => {
        if (alive && (script?.cues?.length || script?.turns?.length)) setTransport(new ScriptedTransport(script));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [enabled]);
  return { enabled, transport };
}

export function VendoRoot({
  children,
  director: directorEligible = true,
}: {
  children: ReactNode;
  threadId?: string;
  /**
   * Set false for read-only surfaces (the dashboard hero slot) that must stay
   * visible in director mode instead of waiting for the script to load.
   */
  director?: boolean;
}) {
  const director = useDirectorTransport();
  // Pinning a previewed app promotes it into the dashboard — nothing is saved
  // to the host surface until the user clicks Pin (06-apps §8 in-client promo).
  const onPin = (app: { appId: string; payload: unknown }) =>
    window.dispatchEvent(new CustomEvent("vendo:pin", { detail: app }));
  // Director mode must NEVER fall through to the live wire: the chat instance
  // binds its transport at creation, so hold the subtree until the script is
  // loaded, then mount once with the scripted transport.
  if (directorEligible && director.enabled && !director.transport) return null;
  if (!directorEligible) {
    return (
      <UmbrellaVendoRoot components={cadenceRegistry} theme={cadenceTheme} tools={cadenceToolMeta} voice={{ driver: cadenceRealtimeVoiceDriver }} onPin={onPin}>
        {children}
      </UmbrellaVendoRoot>
    );
  }
  return (
    <UmbrellaVendoRoot
      key={director.transport ? "vendo-director" : "vendo-live"}
      components={cadenceRegistry}
      theme={cadenceTheme}
      tools={cadenceToolMeta}
      voice={{ driver: cadenceRealtimeVoiceDriver }}
      transport={director.transport}
      onPin={onPin}
    >
      {/* VENDO-MIGRATION: thread selection moved from the provider to each
          thread surface in 08-ui §3; callers retain the prop during migration. */}
      {children}
    </UmbrellaVendoRoot>
  );
}
