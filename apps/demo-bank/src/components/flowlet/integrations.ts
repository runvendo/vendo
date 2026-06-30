"use client";

/**
 * Integrations source backed by the demo connection store (via
 * /api/flowlet/integrations). The store is the single source of truth, so
 * connect/disconnect are REAL on-stage actions: they POST to the store and the
 * agent gains/loses that toolkit on its next turn.
 *
 * Seeded optimistically as ALL DISCONNECTED so the rail paints correctly before
 * the first list() reconciles with the server.
 */
import type { FlowletIntegrations, Integration } from "@flowlet/shell";

const CATALOG: { id: string; name: string }[] = [
  { id: "gmail", name: "Gmail" },
  { id: "slack", name: "Slack" },
  { id: "notion", name: "Notion" },
  { id: "github", name: "GitHub" },
  { id: "googlecalendar", name: "Google Calendar" },
  { id: "linear", name: "Linear" },
  { id: "googledrive", name: "Google Drive" },
  { id: "discord", name: "Discord" },
  { id: "googlesheets", name: "Google Sheets" },
  { id: "stripe", name: "Stripe" },
  { id: "jira", name: "Jira" },
  { id: "asana", name: "Asana" },
  { id: "hubspot", name: "HubSpot" },
  { id: "airtable", name: "Airtable" },
];

export function createComposioIntegrations(): FlowletIntegrations {
  let cache: Integration[] = CATALOG.map((c) => ({ ...c, connected: false }));
  const find = (id: string): Integration =>
    cache.find((i) => i.id === id) ?? { id, name: id, connected: false };

  async function mutate(id: string, action: "connect" | "disconnect"): Promise<Integration> {
    try {
      const res = await fetch("/api/flowlet/integrations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, action }),
        cache: "no-store",
      });
      if (res.ok) {
        const json = (await res.json()) as { data?: { integrations?: Integration[] } };
        if (json.data?.integrations) cache = json.data.integrations;
      }
    } catch {
      /* keep last-known cache; fall through to optimistic value below */
    }
    return find(id);
  }

  return {
    async list() {
      try {
        const res = await fetch("/api/flowlet/integrations", { cache: "no-store" });
        if (res.ok) {
          const json = (await res.json()) as { data?: { integrations?: Integration[] } };
          if (json.data?.integrations) cache = json.data.integrations;
        }
      } catch {
        /* keep last-known cache */
      }
      return cache;
    },
    connect(id) {
      return mutate(id, "connect");
    },
    disconnect(id) {
      return mutate(id, "disconnect");
    },
  };
}
