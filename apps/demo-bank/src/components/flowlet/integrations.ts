"use client";

/**
 * Integrations source backed by live Composio status (via /api/flowlet/integrations).
 * Seeds optimistically as connected so the rail shows correctly on first paint,
 * then reconciles with the real status. connect/disconnect are no-ops in the demo
 * (the OAuth flow is a one-time setup, not an on-stage action).
 */
import type { FlowletIntegrations, Integration } from "@flowlet/shell";

export function createComposioIntegrations(): FlowletIntegrations {
  let cache: Integration[] = [
    { id: "gmail", name: "Gmail", connected: true },
    { id: "slack", name: "Slack", connected: true },
    { id: "notion", name: "Notion", connected: false },
    { id: "github", name: "GitHub", connected: false },
    { id: "googlecalendar", name: "Google Calendar", connected: false },
    { id: "linear", name: "Linear", connected: false },
    { id: "googledrive", name: "Google Drive", connected: false },
  ];
  const find = (id: string): Integration =>
    cache.find((i) => i.id === id) ?? { id, name: id, connected: false };

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
    async connect(id) {
      return find(id);
    },
    async disconnect(id) {
      return find(id);
    },
  };
}
