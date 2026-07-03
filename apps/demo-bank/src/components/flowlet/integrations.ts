"use client";

/**
 * Integrations source backed by the demo connection store (via
 * /api/flowlet/integrations). The store is the single source of truth for what
 * the agent ingests, but a toolkit only becomes connected once Composio reports
 * it ACTIVE:
 *
 *  - connect(id) runs the REAL Composio flow (authorize → OAuth popup → poll).
 *    The status route flips the store on once ACTIVE, so the agent gains the
 *    toolkit on its next turn.
 *  - disconnect(id) flips the store off (it does NOT delete the Composio account).
 *
 * Seeded optimistically as ALL DISCONNECTED so the rail paints correctly before
 * the first list() reconciles with the server.
 */
import type { FlowletIntegrations, Integration } from "@flowlet/shell";
import { runConnectFlow } from "./connect-flow";

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

  async function refresh(): Promise<void> {
    try {
      const res = await fetch("/api/flowlet/integrations", { cache: "no-store" });
      if (res.ok) {
        const json = (await res.json()) as { integrations?: Integration[] };
        if (json.integrations) cache = json.integrations;
      }
    } catch {
      /* keep last-known cache */
    }
  }

  return {
    async list() {
      await refresh();
      return cache;
    },
    async connect(id) {
      // REAL flow: authorize → OAuth popup → poll. The status route marks the
      // store connected once Composio reports ACTIVE; then re-list to reflect it.
      try {
        await runConnectFlow(id);
      } catch {
        /* fall through to a refresh so the rail reflects server truth */
      }
      await refresh();
      return find(id);
    },
    async disconnect(id) {
      try {
        const res = await fetch("/api/flowlet/integrations", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id, action: "disconnect" }),
          cache: "no-store",
        });
        if (res.ok) {
          const json = (await res.json()) as { integrations?: Integration[] };
          if (json.integrations) cache = json.integrations;
        }
      } catch {
        /* keep last-known cache */
      }
      return find(id);
    },
  };
}
