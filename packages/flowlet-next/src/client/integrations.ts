"use client";

/**
 * The shell's integrations seam backed by `createFlowletHandler()`'s
 * endpoints. The server store is the single source of truth for what the
 * agent ingests; this adapter just reflects and drives it.
 */
import type { FlowletIntegrations, Integration } from "@flowlet/shell";
import { runConnectFlow } from "./connect-flow";

export function createServerIntegrations(basePath: string): FlowletIntegrations {
  let cache: Integration[] = [];
  const find = (id: string): Integration =>
    cache.find((i) => i.id === id) ?? { id, name: id, connected: false };

  async function refresh(): Promise<void> {
    try {
      const res = await fetch(`${basePath}/integrations`, { cache: "no-store" });
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
      const outcome = await runConnectFlow(basePath, id);
      await refresh();
      if (outcome.result !== "active") {
        // Surface the failure to the caller UI; the card/tray shows state
        // from list(), which still reads disconnected.
        throw new Error(
          outcome.result === "needs-auth"
            ? "authorization required — popup was blocked"
            : `connect ${outcome.result}`,
        );
      }
      return { ...find(id), connected: true };
    },
    async disconnect(id) {
      const res = await fetch(`${basePath}/integrations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, action: "disconnect" }),
        cache: "no-store",
      });
      if (res.ok) {
        const json = (await res.json()) as { integrations?: Integration[] };
        if (json.integrations) cache = json.integrations;
      }
      return { ...find(id), connected: false };
    },
  };
}
