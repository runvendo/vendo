import { describe, expect, it } from "vitest";
import type { ComposioClient } from "@flowlet/runtime";
import {
  createConnectionsStore,
  handleIntegrationsGet,
  handleIntegrationsPost,
  type IntegrationsDeps,
} from "./integrations";

const CATALOG = [
  { id: "gmail", name: "Gmail" },
  { id: "slack", name: "Slack" },
];

function stubClient(overrides: Partial<ComposioClient> = {}): ComposioClient {
  return {
    fetchTools: async () => ({}),
    authorize: async () => ({ redirectUrl: "https://oauth.example/x", connectedAccountId: "acc-1" }),
    connectionStatus: async () => "active" as const,
    hasActiveConnection: async () => false,
    ...overrides,
  } as ComposioClient;
}

function deps(overrides: Partial<IntegrationsDeps> = {}): IntegrationsDeps {
  return {
    store: createConnectionsStore(CATALOG),
    enabled: true,
    options: {},
    client: stubClient(),
    ...overrides,
  };
}

function get(path: string): Request {
  return new Request(`http://localhost:3000${path}`, { headers: { host: "localhost:3000" } });
}
function post(body: unknown): Request {
  return new Request("http://localhost:3000/api/flowlet/integrations", {
    method: "POST",
    headers: { host: "localhost:3000", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("integrations endpoints", () => {
  it("GET lists the catalog with connected flags", async () => {
    const d = deps();
    d.store.connect("gmail");
    const res = await handleIntegrationsGet(get("/api/flowlet/integrations"), d);
    expect(await res.json()).toEqual({
      enabled: true,
      integrations: [
        { id: "gmail", name: "Gmail", connected: true },
        { id: "slack", name: "Slack", connected: false },
      ],
    });
  });

  it("is inert without a Composio key: GET disabled+empty, POST 503", async () => {
    const d = deps({ enabled: false });
    const res = await handleIntegrationsGet(get("/api/flowlet/integrations"), d);
    expect(await res.json()).toEqual({ enabled: false, integrations: [] });
    const postRes = await handleIntegrationsPost(post({ id: "gmail", action: "connect" }), d);
    expect(postRes.status).toBe(503);
  });

  it("connect fast-paths an already-authorized toolkit into the store", async () => {
    const d = deps({ client: stubClient({ hasActiveConnection: async () => true }) });
    const res = await handleIntegrationsPost(post({ id: "gmail", action: "connect" }), d);
    expect(await res.json()).toEqual({ connected: true });
    expect(d.store.connectedToolkits()).toEqual(["gmail"]);
  });

  it("connect begins OAuth when not yet authorized (store untouched)", async () => {
    const d = deps();
    const res = await handleIntegrationsPost(post({ id: "gmail", action: "connect" }), d);
    expect(await res.json()).toEqual({
      connected: false,
      redirectUrl: "https://oauth.example/x",
      connectedAccountId: "acc-1",
    });
    expect(d.store.connectedToolkits()).toEqual([]);
  });

  it("status poll marks the toolkit connected only when ACTIVE", async () => {
    const d = deps({ client: stubClient({ connectionStatus: async () => "pending" as const }) });
    await handleIntegrationsGet(get("/api/flowlet/integrations?status&id=gmail&account=acc-1"), d);
    expect(d.store.connectedToolkits()).toEqual([]);

    const active = deps();
    await handleIntegrationsGet(get("/api/flowlet/integrations?status&id=gmail&account=acc-1"), active);
    expect(active.store.connectedToolkits()).toEqual(["gmail"]);
  });

  it("disconnect flips the store off; unknown ids never connect", async () => {
    const d = deps();
    d.store.connect("gmail");
    d.store.connect("not-in-catalog");
    expect(d.store.connectedToolkits()).toEqual(["gmail"]);
    const res = await handleIntegrationsPost(post({ id: "gmail", action: "disconnect" }), d);
    expect(((await res.json()) as { integrations: Array<{ connected: boolean }> }).integrations[0]?.connected).toBe(false);
  });
});
