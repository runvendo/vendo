import { describe, expect, it, vi } from "vitest";
import type { ComposioClient } from "@vendoai/runtime";
import { WORLD_SCOPE } from "./guard.js";
import {
  createConnectionsStore,
  handleIntegrationsGet,
  handleIntegrationsPost,
  type IntegrationsDeps,
} from "./integrations.js";

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
  return new Request("http://localhost:3000/api/vendo/integrations", {
    method: "POST",
    headers: { host: "localhost:3000", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("integrations endpoints", () => {
  it("GET lists the catalog with connected flags", async () => {
    const d = deps();
    await d.store.connect("gmail");
    const res = await handleIntegrationsGet(get("/api/vendo/integrations"), d);
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
    const res = await handleIntegrationsGet(get("/api/vendo/integrations"), d);
    expect(await res.json()).toEqual({ enabled: false, integrations: [] });
    const postRes = await handleIntegrationsPost(post({ id: "gmail", action: "connect" }), d);
    expect(postRes.status).toBe(503);
  });

  it("connect fast-paths an already-authorized toolkit into the store", async () => {
    const d = deps({ client: stubClient({ hasActiveConnection: async () => true }) });
    const res = await handleIntegrationsPost(post({ id: "gmail", action: "connect" }), d);
    expect(await res.json()).toEqual({ connected: true });
    expect(await d.store.connectedToolkits()).toEqual(["gmail"]);
  });

  it("connect begins OAuth when not yet authorized (store untouched)", async () => {
    const d = deps();
    const res = await handleIntegrationsPost(post({ id: "gmail", action: "connect" }), d);
    expect(await res.json()).toEqual({
      connected: false,
      redirectUrl: "https://oauth.example/x",
      connectedAccountId: "acc-1",
    });
    expect(await d.store.connectedToolkits()).toEqual([]);
  });

  it("status poll marks the toolkit connected only when ACTIVE", async () => {
    const d = deps({ client: stubClient({ connectionStatus: async () => "pending" as const }) });
    await handleIntegrationsGet(get("/api/vendo/integrations?status&id=gmail&account=acc-1"), d);
    expect(await d.store.connectedToolkits()).toEqual([]);

    const active = deps({ client: stubClient({ hasActiveConnection: async () => true }) });
    await handleIntegrationsGet(get("/api/vendo/integrations?status&id=gmail&account=acc-1"), active);
    expect(await active.store.connectedToolkits()).toEqual(["gmail"]);
  });

  it("status poll does NOT flip a toolkit the user has no active connection for (review P1)", async () => {
    // Active account, but hasActiveConnection(gmail) is false → must not connect.
    const d = deps({
      client: stubClient({ connectionStatus: async () => "active" as const, hasActiveConnection: async () => false }),
    });
    await handleIntegrationsGet(get("/api/vendo/integrations?status&id=slack&account=someones-gmail-acct"), d);
    expect(await d.store.connectedToolkits()).toEqual([]);
  });

  it("status poll reports 'active' only when the store write happened; a foreign active account is not connected (review)", async () => {
    // Composio says the polled account is ACTIVE, but it is not THIS user's
    // connection for THIS toolkit → the store was never written, so the
    // client-facing status must NOT read as connected.
    const d = deps({
      client: stubClient({
        connectionStatus: async () => "active" as const,
        hasActiveConnection: async () => false,
      }),
    });
    const res = await handleIntegrationsGet(
      get("/api/vendo/integrations?status&id=gmail&account=foreign-acct"),
      d,
    );
    expect(await res.json()).toEqual({ status: "pending" });
    expect(await d.store.connectedToolkits()).toEqual([]);
  });

  it("status poll logs server-side and reports transient 'pending' when Composio throws (review)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const d = deps({
        client: stubClient({
          connectionStatus: async () => {
            throw new Error("composio blip");
          },
        }),
      });
      const res = await handleIntegrationsGet(
        get("/api/vendo/integrations?status&id=gmail&account=acc-1"),
        d,
      );
      // A poll error is transient, not terminal — client keeps polling.
      expect(await res.json()).toEqual({ status: "pending" });
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  it("rejects an unknown toolkit id before spending the Composio key (review P1)", async () => {
    let authorizeCalls = 0;
    const d = deps({
      client: stubClient({
        authorize: async () => {
          authorizeCalls++;
          return { redirectUrl: "x", connectedAccountId: "y" };
        },
      }),
    });
    const res = await handleIntegrationsPost(post({ id: "evilcorp", action: "connect" }), d);
    expect(res.status).toBe(400);
    expect(authorizeCalls).toBe(0);
  });

  it("status poll captures the connected-account id for webhook routing (Task 13 Step 1)", async () => {
    const d = deps({
      client: stubClient({
        connectionStatus: async () => "active" as const,
        hasActiveConnection: async () => true,
      }),
    });
    await handleIntegrationsGet(get("/api/vendo/integrations?status&id=gmail&account=acc-42"), d);
    expect(await d.store.connectedToolkits()).toEqual(["gmail"]);
    await expect(d.store.findByConnectedAccount("acc-42")).resolves.toEqual({
      toolkit: "gmail",
      principal: WORLD_SCOPE,
    });
  });

  it("findByConnectedAccount resolves undefined for an account never captured", async () => {
    const d = deps();
    await expect(d.store.findByConnectedAccount("nope")).resolves.toBeUndefined();
  });

  it("disconnect revokes webhook routing — findByConnectedAccount no longer resolves the mapping (review blocker)", async () => {
    const d = deps();
    await d.store.setConnectedAccount("gmail", "acc-42");
    await expect(d.store.findByConnectedAccount("acc-42")).resolves.toEqual({
      toolkit: "gmail",
      principal: WORLD_SCOPE,
    });

    await d.store.disconnect("gmail");

    await expect(d.store.findByConnectedAccount("acc-42")).resolves.toBeUndefined();
  });

  it("disconnect flips the store off; unknown ids never connect", async () => {
    const d = deps();
    await d.store.connect("gmail");
    await d.store.connect("not-in-catalog");
    expect(await d.store.connectedToolkits()).toEqual(["gmail"]);
    const res = await handleIntegrationsPost(post({ id: "gmail", action: "disconnect" }), d);
    expect(((await res.json()) as { integrations: Array<{ connected: boolean }> }).integrations[0]?.connected).toBe(false);
  });
});
