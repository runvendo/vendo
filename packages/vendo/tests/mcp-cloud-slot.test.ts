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

  it("keeps one flight per outcome across a failed open, and never clears a good one", async () => {
    vi.stubEnv("VENDO_API_KEY", "vk_test");
    vi.stubEnv("VENDO_BASE_URL", "https://host.test");
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    const calls: string[] = [];
    let down = true;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (!url.endsWith("/api/v1/mcp")) return new Response("{}", { status: 200 });
      calls.push(url);
      // A slow console is what makes the flights actually overlap.
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (down) return new Response("bad gateway", { status: 502 });
      return Response.json({
        issuer: CLOUD_ISSUER,
        audience: `${CLOUD_ISSUER}/mcp`,
        federation_secret: "fed_0123456789abcdef",
        service_key: "vsk_cloud_0123456789abcdef",
      });
    });

    const vendo = await compose(true);
    const burst = async (): Promise<void> => {
      await Promise.all(Array.from({ length: 6 }, async () =>
        vendo.handler(new Request(PRM)).catch(() => undefined)));
    };

    // Six concurrent FIRST uses against a console that is down: still one flight.
    await burst();
    expect(calls, "the failed open lost its single-flight latch").toHaveLength(1);

    down = false;
    // Six concurrent retries: exactly one more flight, and it succeeds.
    await burst();
    expect(calls).toHaveLength(2);

    // The successful open must now be the cache — a `.catch` that cleared it
    // would show up here as a third flight.
    await burst();
    expect(calls, "a good open was cleared by the rejection handler").toHaveLength(2);
    expect(await authorizationServer(vendo)).toBe(CLOUD_ISSUER);

    await new Promise((resolve) => setTimeout(resolve, 0));
    process.off("unhandledRejection", onUnhandled);
    expect(unhandled, "the rejected open escaped as an unhandled rejection").toEqual([]);
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

  it("shows the console's own refusal, not \"Internal Vendo error\"", async () => {
    vi.stubEnv("VENDO_API_KEY", "vk_test");
    // Init's default dev URL, which production Cloud refuses to forward to.
    vi.stubEnv("VENDO_BASE_URL", "http://localhost:3004");
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (!String(input).endsWith("/api/v1/mcp")) return new Response("{}", { status: 200 });
      // Production Cloud's real answer, envelope and docs link included.
      return new Response(JSON.stringify({
        error: {
          code: "validation",
          message: "The forwarding address must be an https:// URL. "
            + "https://docs.vendo.run/outside-agents/service-keys-and-broker",
        },
      }), { status: 400, headers: { "content-type": "application/json" } });
    });

    const vendo = await compose(true);
    const response = await vendo.handler(new Request(PRM));
    const body = await response.text();

    // The console handed the product a perfect, actionable, docs-linked reason.
    // Answering 501 "Internal Vendo error" throws it away and blames the app.
    expect(response.status, body).toBe(400);
    expect(body).toContain("must be an https:// URL");
    expect(body).toContain("https://docs.vendo.run/outside-agents/service-keys-and-broker");
    expect(body).not.toContain("Internal Vendo error");
  });

  it("still reports a console 5xx as Cloud's failure, not the caller's", async () => {
    vi.stubEnv("VENDO_API_KEY", "vk_test");
    vi.stubEnv("VENDO_BASE_URL", "https://host.test");
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (!String(input).endsWith("/api/v1/mcp")) return new Response("{}", { status: 200 });
      return new Response("upstream boom", { status: 502 });
    });

    const vendo = await compose(true);
    const body = await (await vendo.handler(new Request(PRM))).text();
    // Cloud's fault, and it says so — the developer's app is not implicated,
    // and the raw upstream body is not echoed back at them.
    expect(body).toContain("Vendo Cloud");
    expect(body).not.toContain("upstream boom");
  });

  it("never echoes a console body that is not the envelope, whatever it carries", async () => {
    vi.stubEnv("VENDO_API_KEY", "vk_live_SUPERSECRET");
    vi.stubEnv("VENDO_BASE_URL", "https://host.test");
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (!String(input).endsWith("/api/v1/mcp")) return new Response("{}", { status: 200 });
      // A 4xx that is NOT the envelope — a gateway page, a proxy, a stack
      // trace. Only `error.message` is ever repeated, so none of this can be.
      return new Response("denied for key vk_live_SUPERSECRET at 10.0.0.4", { status: 403 });
    });

    const vendo = await compose(true);
    const body = await (await vendo.handler(new Request(PRM))).text();
    expect(body).not.toContain("vk_live_SUPERSECRET");
    expect(body).not.toContain("10.0.0.4");
    expect(body).not.toContain("denied for key");
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
