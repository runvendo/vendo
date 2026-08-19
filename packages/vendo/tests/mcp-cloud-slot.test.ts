/**
 * THE ADAPTER RULE at the mcp seam: explicit option → the declared env pair →
 * Vendo Cloud → local, and the Cloud rung provisions on FIRST USE, never at
 * compose.
 *
 * The console is the one thing not real here — it is built in a sibling lane,
 * and the fixture below IS its wire contract (cloud-secrets.test.ts's posture).
 * Everything downstream of it is: the assertions read the COMPOSED DOOR's own
 * discovery documents and routing, so a bundle that failed to reach the door
 * cannot pass — a broker-fronted door names the broker as its authorization
 * server and stops serving its own `/token`, and a local one does neither.
 */
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MOUNT, principal, runCleanups, SUBJECT, tempStore } from "../src/mcp-door.test-util.js";
import { createVendo, type Vendo } from "../src/server.js";

afterEach(runCleanups);
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const PRM = "https://host.test/.well-known/oauth-protected-resource/api/vendo/mcp";
const CLOUD_ISSUER = "https://acme.mcp.vendo.run";

/** The console's answer to `POST /api/v1/mcp`, and the log of what was asked.
    Scoped to that ONE path: a keyed deployment's other Cloud slots talk to the
    console too, and this seam's whole claim is about the mcp call. */
const consoleFixture = (): { url: string; body: unknown }[] => {
  const calls: { url: string; body: unknown }[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.endsWith("/api/v1/mcp")) return new Response("{}", { status: 200 });
    calls.push({ url, body: JSON.parse(String(init?.body)) as unknown });
    return new Response(JSON.stringify({
      issuer: CLOUD_ISSUER,
      audience: `${CLOUD_ISSUER}/mcp`,
      federation_secret: "fed_0123456789abcdef",
      service_key: "vsk_cloud_0123456789abcdef",
    }), { status: 200, headers: { "content-type": "application/json" } });
  });
  return calls;
};

const compose = async (mcp: unknown): Promise<Vendo> => {
  const store = await tempStore();
  const vendo = createVendo({
    models: { default: {} as LanguageModel },
    principal: async () => principal,
    store,
    guard: { policy: "cautious" },
    mcp,
    oauth: {
      async session() {
        return { subject: SUBJECT };
      },
      async principal(subject: string) {
        return { kind: "user", subject };
      },
    },
  } as Parameters<typeof createVendo>[0]);
  await store.ensureSchema();
  return vendo;
};

const authorizationServer = async (vendo: Vendo): Promise<string> => {
  const response = await vendo.handler(new Request(PRM));
  const body = await response.json() as { authorization_servers: string[] };
  return body.authorization_servers[0]!;
};

describe("the mcp seam's Cloud rung", () => {
  it("provisions the tenant on first use — never at compose — and once per process", async () => {
    vi.stubEnv("VENDO_API_KEY", "vk_test");
    vi.stubEnv("VENDO_BASE_URL", "https://host.test");
    const calls = consoleFixture();

    const vendo = await compose(true);
    // The whole point of the lazy rung: composing a deployment does no I/O, so
    // a console outage cannot stop one booting and a Worker can compose at all.
    expect(calls).toHaveLength(0);

    expect(await authorizationServer(vendo)).toBe(CLOUD_ISSUER);
    expect(calls).toEqual([{
      url: "https://console.vendo.run/api/v1/mcp",
      // The tenant's forwarding address: where the broker sends users back to.
      body: { base_url: "https://host.test" },
    }]);

    await authorizationServer(vendo);
    expect(calls).toHaveLength(1);
  });

  it("hands the door a broker, so the door stops serving its own token endpoint", async () => {
    vi.stubEnv("VENDO_API_KEY", "vk_test");
    consoleFixture();
    const vendo = await compose(true);

    const response = await vendo.handler(new Request(`${MOUNT}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code" }),
    }));
    expect(response.status).toBe(404);
  });

  it("lets the declared env pair outrank Cloud, without a console call", async () => {
    vi.stubEnv("VENDO_API_KEY", "vk_test");
    vi.stubEnv("VENDO_MCP_BROKER_URL", "https://own.broker.test/mcp");
    const calls = consoleFixture();

    expect(await authorizationServer(await compose(true))).toBe("https://own.broker.test");
    expect(calls).toHaveLength(0);
  });

  it("lets an explicit mcp.remoteAs outrank both", async () => {
    vi.stubEnv("VENDO_API_KEY", "vk_test");
    vi.stubEnv("VENDO_MCP_BROKER_URL", "https://own.broker.test/mcp");
    const calls = consoleFixture();

    const vendo = await compose({
      remoteAs: { issuer: "https://passed.test", audience: "https://passed.test/mcp" },
    });
    expect(await authorizationServer(vendo)).toBe("https://passed.test");
    expect(calls).toHaveLength(0);
  });

  it("retries after a console blip instead of wedging the door shut for the process", async () => {
    vi.stubEnv("VENDO_API_KEY", "vk_test");
    vi.stubEnv("VENDO_BASE_URL", "https://host.test");
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (!url.endsWith("/api/v1/mcp")) return new Response("{}", { status: 200 });
      calls.push(url);
      // The console is down for exactly one request, then well again.
      if (calls.length === 1) return new Response("bad gateway", { status: 502 });
      return new Response(JSON.stringify({
        issuer: CLOUD_ISSUER,
        audience: `${CLOUD_ISSUER}/mcp`,
        federation_secret: "fed_0123456789abcdef",
        service_key: "vsk_cloud_0123456789abcdef",
      }), { status: 200, headers: { "content-type": "application/json" } });
    });

    const vendo = await compose(true);
    await vendo.handler(new Request(PRM)).catch(() => undefined);

    // Only a SUCCESSFUL provisioning is the one-per-process cache, so the very
    // next request provisions again and the door opens.
    const second = await vendo.handler(new Request(PRM)).catch(() => undefined);
    expect(calls, "the door never asked the console a second time").toHaveLength(2);
    expect(second?.status).toBe(200);
    expect(await authorizationServer(vendo)).toBe(CLOUD_ISSUER);
  });

  it("gives each composed deployment its own bundle, never a shared one", async () => {
    vi.stubEnv("VENDO_API_KEY", "vk_test");
    const calls = consoleFixture();

    const first = await compose(true);
    const second = await compose(true);
    expect(await authorizationServer(first)).toBe(CLOUD_ISSUER);
    expect(await authorizationServer(second)).toBe(CLOUD_ISSUER);
    expect(calls).toHaveLength(2);
  });

  it("provisions once when the door and tokenFor both need the tenant at the same moment", async () => {
    vi.stubEnv("VENDO_API_KEY", "vk_test");
    vi.stubEnv("VENDO_BASE_URL", "https://host.test");
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `${CLOUD_ISSUER}/token`) return Response.json({ access_token: "vmat_x" });
      if (!url.endsWith("/api/v1/mcp")) return new Response("{}", { status: 200 });
      calls.push(url);
      await new Promise((resolve) => setTimeout(resolve, 10));
      return Response.json({
        issuer: CLOUD_ISSUER,
        audience: `${CLOUD_ISSUER}/mcp`,
        federation_secret: "fed_0123456789abcdef",
        service_key: "vsk_cloud_0123456789abcdef",
      });
    });

    const vendo = await compose(true);
    await Promise.all([authorizationServer(vendo), vendo.tokenFor(SUBJECT), authorizationServer(vendo)]);
    expect(calls).toHaveLength(1);
  });

  it("leaves the keyless BYO door local and offline", async () => {
    const calls = consoleFixture();
    const vendo = await compose(true);

    // Its own mount is its own authorization server, and it serves the AS
    // metadata a broker-fronted door 404s.
    expect(await authorizationServer(vendo)).toBe(MOUNT);
    const as = await vendo.handler(new Request(
      "https://host.test/.well-known/oauth-authorization-server/api/vendo/mcp",
    ));
    expect(as.status).toBe(200);
    expect(calls).toHaveLength(0);
  });

  it("leaves a door with its own serviceAuth local, key or no key", async () => {
    vi.stubEnv("VENDO_API_KEY", "vk_test");
    const calls = consoleFixture();
    const vendo = await compose({ serviceAuth: { keys: ["vsk_own_key"] } });

    expect(await authorizationServer(vendo)).toBe(MOUNT);
    expect(calls).toHaveLength(0);
  });
});
