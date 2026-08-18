/**
 * A host tool call is a Cloud round trip's twin: it goes out between two turns
 * of an agent, across a gap longer than the ~4s Node's stock dispatcher holds
 * an idle socket, so every one of them was paying a fresh TCP+TLS handshake.
 * Composition hands the registry the same keep-alive pool the store already
 * rides — and a host that brings its own fetch still wins (adapter rule).
 */
import type { Principal, RunContext } from "@vendoai/core";
import { memoryStoreAdapter } from "@vendoai/core/conformance";
import type { LanguageModel } from "ai";
import { Agent } from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createVendo, type ExtractedTool } from "../src/server.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.unstubAllEnvs();
});

beforeEach(() => {
  vi.stubEnv("VENDO_BASE_URL", "https://host.test");
});

const principal: Principal = { kind: "user", subject: "user_keepalive" };

const invoices: ExtractedTool = {
  name: "host_invoices",
  title: "List invoices",
  description: "List the signed-in customer's invoices",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  risk: "read",
  binding: { kind: "route", method: "GET", path: "/api/invoices", argsIn: "query" },
} as ExtractedTool;

function captureFetch(): Array<{ input: unknown; init?: RequestInit }> {
  const calls: Array<{ input: unknown; init?: RequestInit }> = [];
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    calls.push({ input, init });
    return Promise.resolve(new Response("[]", { headers: { "content-type": "application/json" } }));
  }) as typeof fetch;
  return calls;
}

const ctx: RunContext = {
  principal,
  venue: "chat",
  presence: "present",
  sessionId: "session_keepalive",
};

const compose = (fetchImpl?: typeof fetch) =>
  createVendo({
    models: { default: {} as LanguageModel },
    principal: async () => principal,
    store: memoryStoreAdapter(),
    tools: [invoices],
    ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
  } as unknown as Parameters<typeof createVendo>[0]);

describe("host-API calls ride the keep-alive pool", () => {
  it("sends an unconfigured deployment's host tool call over the shared pool", async () => {
    const calls = captureFetch();

    await compose().actions.execute(
      { id: "call_keepalive", tool: invoices.name, args: {} },
      ctx,
    );

    expect(calls).toHaveLength(1);
    expect((calls[0]?.init as { dispatcher?: unknown } | undefined)?.dispatcher)
      .toBeInstanceOf(Agent);
  });

  it("lets an explicitly passed fetch win (adapter rule)", async () => {
    captureFetch();
    const mine = vi.fn(async () =>
      new Response("[]", { headers: { "content-type": "application/json" } }));

    await compose(mine as unknown as typeof fetch).actions.execute(
      { id: "call_own_fetch", tool: invoices.name, args: {} },
      ctx,
    );

    expect(mine).toHaveBeenCalledTimes(1);
  });
});
