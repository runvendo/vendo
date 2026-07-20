import { describe, expect, it } from "vitest";
import type { RunContext } from "@vendoai/core";
import type { Connector } from "../connectors/connector.js";
import { createActions } from "./registry.js";

/** A lazy fake: index of 2 toolkits, per-toolkit tools materialize on expand. */
function lazyConnector() {
  const expanded = new Set<string>();
  const connector: Connector = {
    name: "composio",
    descriptors: async () => [...expanded].map((toolkit) => ({
      name: `${toolkit}_${toolkit.toUpperCase()}_SEND`,
      description: `send things via ${toolkit}`,
      inputSchema: {},
      risk: "write" as const,
    })),
    execute: async (call) => ({ status: "ok", output: { ran: call.tool } }),
    discoveryIndex: async () => [
      { toolkit: "gmail", label: "Gmail", description: "Send and read email with Gmail" },
      { toolkit: "slack", label: "Slack", description: "Post messages to Slack channels" },
    ],
    expandToolkits: async (toolkits) => {
      let changed = false;
      for (const toolkit of toolkits) {
        if (["gmail", "slack"].includes(toolkit) && !expanded.has(toolkit)) {
          expanded.add(toolkit);
          changed = true;
        }
      }
      return changed;
    },
  };
  return connector;
}

const HOST_TOOL = {
  name: "host_listAccounts",
  description: "List the user's accounts",
  inputSchema: { type: "object" },
  risk: "read" as const,
  binding: { kind: "route" as const, method: "GET" as const, path: "/api/accounts", argsIn: "query" as const },
};

const ctx: RunContext = { principal: { kind: "user", subject: "user_ada" }, venue: "chat", presence: "present", sessionId: "s1" };

function registry() {
  return createActions({ dir: "", tools: [HOST_TOOL], connectors: [lazyConnector()] });
}

describe("registry lazy expansion", () => {
  it("boots with host tools only; expansion grows descriptors AND dispatch", async () => {
    const actions = registry();
    expect((await actions.descriptors()).map((d) => d.name)).toEqual(["host_listAccounts"]);
    await actions.expandToolkits(["gmail"]);
    const names = (await actions.descriptors()).map((d) => d.name);
    expect(names).toContain("gmail_GMAIL_SEND");
    const outcome = await actions.execute({ id: "c1", tool: "gmail_GMAIL_SEND", args: {} }, ctx);
    expect(outcome).toMatchObject({ status: "ok" });
  });

  it("loadoutSeed = host tools first, then ONLY the connected toolkits' tools", async () => {
    const actions = registry();
    const seed = await actions.loadoutSeed(["gmail"]);
    expect(seed[0]).toBe("host_listAccounts");
    expect(seed).toContain("gmail_GMAIL_SEND");
    expect(seed.join(",")).not.toContain("slack");
  });

  it("zero connections: seed is host tools only", async () => {
    await expect(registry().loadoutSeed([])).resolves.toEqual(["host_listAccounts"]);
  });

  it("search expands matching index toolkits and annotates their results", async () => {
    const actions = registry();
    const matches = await actions.search("send an email");
    const gmail = matches.find((match) => match.name === "gmail_GMAIL_SEND");
    expect(gmail).toBeDefined();
    expect(gmail!.description).toContain("gmail");
    expect(gmail!.description).toMatch(/connect/i);
    // slack's blurb doesn't match "email" → stays unexpanded
    expect((await actions.descriptors()).map((d) => d.name)).not.toContain("slack_SLACK_SEND");
  });

  it("search with no index match behaves exactly as before", async () => {
    const matches = await registry().search("list accounts");
    expect(matches[0]!.name).toBe("host_listAccounts");
    expect(matches[0]!.description).not.toMatch(/toolkit/);
  });
});
