import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore, type VendoStore } from "@vendoai/store";
import { createVendo, type CreateVendoConfig, type Vendo } from "./server.js";
import { publicBaseUrl, selectMcpBroker } from "./mcp-broker-select.js";

// Task B2 of the MCP broker provisioning plan: the mcp seam's selection —
// cloned from selectConnections' adapter rule. Explicit `mcp.remoteAs` wins
// verbatim (no ensure call); else a Cloud key + a PUBLIC base URL default the
// hosted broker (ensure-tenant at the composition boundary, remoteAs +
// federation wired from the response); else today's local door, byte-identical.
// The localhost rule and the ensure request bytes are the plan's FROZEN WIRE
// CONTRACT.

const MOUNT = "/api/vendo/mcp";
const cloud = { apiKey: "vnd_broker_key" };

describe("selectMcpBroker (pure)", () => {
  it("answers off when the door is closed", () => {
    expect(selectMcpBroker(undefined, cloud, "https://app.example.com", MOUNT)).toEqual({ mode: "off" });
  });

  it("explicit mcp.remoteAs wins verbatim — no ensure even with a key and a public URL", () => {
    const selection = selectMcpBroker(
      { remoteAs: { issuer: "https://own-as.example.com", audience: "https://app.example.com/api/vendo/mcp" } },
      cloud,
      "https://app.example.com",
      MOUNT,
    );
    expect(selection).toEqual({ mode: "explicit" });
  });

  it("a key plus a public base URL defaults the hosted broker with the ensure input", () => {
    expect(selectMcpBroker({}, cloud, "https://app.maplebank.com", MOUNT)).toEqual({
      mode: "broker",
      ensure: { baseUrl: "https://app.maplebank.com", mount: MOUNT },
    });
  });

  it("no key keeps today's local door even on a public URL", () => {
    expect(selectMcpBroker({}, undefined, "https://app.maplebank.com", MOUNT)).toEqual({ mode: "local" });
  });

  it("skips the broker default for every localhost/private base URL shape (the frozen localhost rule)", () => {
    for (const baseUrl of [
      undefined,
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "http://[::1]:3000",
      "https://demo.local",
      "https://10.1.2.3",
      "https://192.168.1.5:8443",
      "https://172.16.0.1",
      "https://172.31.255.255",
      "not a url",
      // Canonical alternate spellings of the same private/loopback hosts: a
      // trailing-dot FQDN and IPv4-mapped IPv6 (URL serializes the mapped
      // form as hex groups, e.g. [::ffff:7f00:1]) still name the same
      // unreachable machine — the frozen rule covers the HOST, not the bytes.
      "https://localhost.",
      "https://foo.local.",
      "https://[::ffff:127.0.0.1]",
      "https://[::ffff:10.0.0.1]",
      "https://[::ffff:192.168.1.2]",
      "https://[::ffff:172.16.1.2]",
      "https://[::ffff:a00:1]",
    ]) {
      expect(selectMcpBroker({}, cloud, baseUrl, MOUNT), String(baseUrl)).toEqual({ mode: "local" });
    }
  });

  it("publicBaseUrl keeps genuinely public hosts — 172.32.x is outside RFC1918", () => {
    expect(publicBaseUrl("https://172.32.0.1")).toBe("https://172.32.0.1");
    expect(publicBaseUrl("https://app.maplebank.com")).toBe("https://app.maplebank.com");
    expect(publicBaseUrl("https://mylocal.example.com")).toBe("https://mylocal.example.com");
    // The normalizations must not over-reach: a trailing-dot PUBLIC FQDN, an
    // IPv4-mapped PUBLIC address, and a plain public IPv6 all stay public.
    expect(publicBaseUrl("https://app.maplebank.com.")).toBe("https://app.maplebank.com.");
    expect(publicBaseUrl("https://[::ffff:8.8.8.8]")).toBe("https://[::ffff:8.8.8.8]");
    expect(publicBaseUrl("https://[2606:4700::1111]")).toBe("https://[2606:4700::1111]");
  });

  // Checker round 2 (F1): the trailing-dot strip must be exhaustive, not
  // dot-count-specific — `localhost..` names the same unreachable machine as
  // `localhost.`, and URL percent-decodes `%2e` into those dots for http(s).
  it("strips ALL trailing root-label dots — multi-dot and percent-encoded spellings stay private", () => {
    for (const baseUrl of [
      "https://localhost..",
      "https://localhost...",
      "https://foo.local..",
      "https://127.0.0.1..",
      "https://10.0.0.1..",
      "https://192.168.1.5..",
      "https://localhost%2e%2e",
      "https://127.0.0.1%2e%2e",
      "https://foo%2elocal%2e%2e",
    ]) {
      expect(selectMcpBroker({}, cloud, baseUrl, MOUNT), baseUrl).toEqual({ mode: "local" });
    }
  });

  it("a hostname that normalizes to empty is never public", () => {
    expect(publicBaseUrl("https://.")).toBeUndefined();
    expect(publicBaseUrl("https://..")).toBeUndefined();
    expect(publicBaseUrl("https://%2e%2e")).toBeUndefined();
  });

  it("the exhaustive strip keeps genuinely public hosts public, bytes preserved", () => {
    expect(publicBaseUrl("https://app.maplebank.com..")).toBe("https://app.maplebank.com..");
    expect(publicBaseUrl("https://localhost.example.com")).toBe("https://localhost.example.com");
    expect(publicBaseUrl("https://my-local.com")).toBe("https://my-local.com");
    expect(publicBaseUrl("https://10.example.com")).toBe("https://10.example.com");
    expect(publicBaseUrl("https://172.32.0.1..")).toBe("https://172.32.0.1..");
  });
});

// ---------------------------------------------------------------------------
// Composition: the seam consumed where the door is composed.
// ---------------------------------------------------------------------------

const ensureResponse = {
  tenant: {
    slug: "maple",
    issuer: "https://maple.mcp.vendo.run",
    audience: "https://maple.mcp.vendo.run/mcp",
    status: "active",
    upstreamOrigin: "https://app.maplebank.com",
    upstreamMount: MOUNT,
  },
  federationSecret: "umbrella-federation-secret-with-entropy",
};

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Temp-dir PGlite store with registered teardown (server.test.ts pattern):
 * teardown awaits schema readiness first — closing PGlite mid-query hangs. */
async function tempStore(): Promise<VendoStore> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-broker-seam-"));
  const store = createStore({ dataDir });
  cleanups.push(async () => {
    await store.ensureSchema().catch(() => undefined);
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

function fakeConsole(respond: () => Response): {
  requests: Array<{ authorization: string | null; body: unknown }>;
  handler: typeof fetch;
} {
  const requests: Array<{ authorization: string | null; body: unknown }> = [];
  const handler = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.host !== "cloud-mcp.test" || url.pathname !== "/api/v1/mcp/tenant") {
      throw new Error(`unexpected fetch during composition: ${request.url}`);
    }
    requests.push({
      authorization: request.headers.get("authorization"),
      body: await request.json(),
    });
    return respond();
  }) as typeof fetch;
  return { requests, handler };
}

async function composeVendo(options: {
  respond?: () => Response;
  baseUrl?: string | null;
  mcp?: CreateVendoConfig["mcp"];
  /** The /doctor/mcp probe is mounted only in a development composition. */
  development?: boolean;
}): Promise<{ vendo: Vendo; requests: Array<{ authorization: string | null; body: unknown }> }> {
  vi.stubEnv("VENDO_API_KEY", "vnd_broker_key");
  vi.stubEnv("VENDO_CLOUD_URL", "https://cloud-mcp.test");
  if (options.baseUrl !== null) vi.stubEnv("VENDO_BASE_URL", options.baseUrl ?? "https://app.maplebank.com");
  const console_ = fakeConsole(options.respond ?? (() => Response.json(ensureResponse)));
  vi.stubGlobal("fetch", console_.handler);
  const vendo = createVendo({
    model: {} as LanguageModel,
    principal: async () => null,
    store: await tempStore(),
    mcp: options.mcp ?? true,
    ...(options.development === undefined ? {} : { development: options.development }),
    oauth: {
      async authorize() { return { subject: "user_door" }; },
      async principal(subject) { return { kind: "user", subject }; },
    },
  });
  return { vendo, requests: console_.requests };
}

const root = (path: string): Request => new Request(`https://host.test${path}`);
const PRM_PATH = "/.well-known/oauth-protected-resource/api/vendo/mcp";

const statusMcp = async (vendo: Vendo): Promise<unknown> => {
  const response = await vendo.handler(root("/api/vendo/status"));
  expect(response.status).toBe(200);
  return (await response.json() as { blocks: { mcp: unknown } }).blocks.mcp;
};

/** Compact HS256 JWS, enough to speak the 10-mcp §3.2 handshake in-test. */
function signHs256(secret: string, payload: Record<string, unknown>): string {
  const part = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  const signingInput = `${part({ alg: "HS256", typ: "JWT" })}.${part(payload)}`;
  const signature = createHmac("sha256", secret).update(signingInput).digest("base64url");
  return `${signingInput}.${signature}`;
}

describe("the broker arm: key + public VENDO_BASE_URL ensures a tenant and wires remoteAs + federation", () => {
  it("ensures once with the frozen request bytes and fronts the door with the tenant", async () => {
    const { vendo, requests } = await composeVendo({});

    const prm = await vendo.handler(root(PRM_PATH));
    expect(prm.status).toBe(200);
    expect((await prm.json() as { authorization_servers?: string[] }).authorization_servers)
      .toEqual(["https://maple.mcp.vendo.run"]);
    // Remote-AS mode: the door stops serving its own authorization-server surface.
    expect((await vendo.handler(root("/.well-known/oauth-authorization-server/api/vendo/mcp"))).status).toBe(404);

    expect(await statusMcp(vendo)).toBe("broker");

    // One ensure for the whole composition — the frozen request, key-authed.
    expect(requests).toEqual([{
      authorization: "Bearer vnd_broker_key",
      body: { baseUrl: "https://app.maplebank.com", mount: MOUNT },
    }]);
  });

  it("wires federation from the ensured secret — the broker's signed login handshake lands", async () => {
    const { vendo } = await composeVendo({});
    const now = Math.floor(Date.now() / 1_000);
    const request = signHs256(ensureResponse.federationSecret, {
      iss: ensureResponse.tenant.issuer,
      aud: "https://app.maplebank.com/api/vendo/mcp",
      exp: now + 300,
      jti: "broker-seam-nonce",
      redirect_uri: `${ensureResponse.tenant.issuer}/federation/callback`,
      scopes: ["tools"],
      client_name: "Vendo broker",
    });
    const federated = await vendo.handler(root(`/api/vendo/mcp/federate?request=${request}`));
    expect(federated.status).toBe(302);
    const assertion = new URL(federated.headers.get("location")!).searchParams.get("assertion")!;
    const payload = JSON.parse(Buffer.from(assertion.split(".")[1]!, "base64url").toString()) as Record<string, unknown>;
    expect(payload).toMatchObject({ sub: "user_door", jti: "broker-seam-nonce" });
  });

  it("a disabled tenant still composes remoteAs — the broker refuses traffic, the host stays consistent", async () => {
    const { vendo } = await composeVendo({
      respond: () => Response.json({
        ...ensureResponse,
        tenant: { ...ensureResponse.tenant, status: "disabled" },
      }),
    });
    const prm = await vendo.handler(root(PRM_PATH));
    expect((await prm.json() as { authorization_servers?: string[] }).authorization_servers)
      .toEqual(["https://maple.mcp.vendo.run"]);
    expect(await statusMcp(vendo)).toBe("broker");
  });

  it("an ensure failure at composition degrades to the local door with one loud warn — boot survives", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { vendo, requests } = await composeVendo({
      respond: () => new Response("bad gateway", { status: 502 }),
    });

    // The local door serves its own OAuth surface; nothing died.
    const as = await vendo.handler(root("/.well-known/oauth-authorization-server/api/vendo/mcp"));
    expect(as.status).toBe(200);
    expect((await as.json() as { issuer?: string }).issuer).toBe("https://app.maplebank.com/api/vendo/mcp");
    expect(await statusMcp(vendo)).toBe("local");

    // Loud, once — the degrade is latched with the composed door.
    const brokerWarns = warn.mock.calls.filter((call) => String(call[0]).includes("MCP broker"));
    expect(brokerWarns).toHaveLength(1);
    expect(String(brokerWarns[0]![0])).toContain("local");
    expect(requests).toHaveLength(1);
  });
});

describe("the dev-only /doctor/mcp probe reports the seam's selection", () => {
  // /status collapses explicit-remoteAs and the Cloud-managed broker into one
  // "broker" posture (the frozen shape); doctor needs the distinction to keep
  // the explicit-wins precedence — it must never ensure a tenant for an
  // explicitly configured AS. The probe carries the seam's own selection.
  const selectionOf = async (vendo: Vendo): Promise<unknown> => {
    const response = await vendo.handler(root("/api/vendo/doctor/mcp"));
    expect(response.status).toBe(200);
    return (await response.json() as { selection: unknown }).selection;
  };

  it("broker arm → \"broker\"", async () => {
    const { vendo } = await composeVendo({ development: true });
    expect(await selectionOf(vendo)).toBe("broker");
  });

  it("explicit mcp.remoteAs → \"explicit\", though /status says \"broker\" for both", async () => {
    const { vendo } = await composeVendo({
      development: true,
      mcp: { remoteAs: { issuer: "https://own-as.example.com", audience: "https://app.maplebank.com/api/vendo/mcp" } },
    });
    expect(await statusMcp(vendo)).toBe("broker");
    expect(await selectionOf(vendo)).toBe("explicit");
  });

  it("localhost skip → \"local\"", async () => {
    const { vendo } = await composeVendo({ development: true, baseUrl: "http://localhost:3000" });
    expect(await selectionOf(vendo)).toBe("local");
  });

  it("is not mounted at all without the development opt-in", async () => {
    const { vendo } = await composeVendo({});
    expect((await vendo.handler(root("/api/vendo/doctor/mcp"))).status).toBe(404);
  });
});

describe("the other arms stay byte-identical", () => {
  it("explicit mcp.remoteAs wins verbatim — no ensure call rides the wire", async () => {
    const issuer = "https://own-as.example.com";
    const { vendo, requests } = await composeVendo({
      mcp: { remoteAs: { issuer, audience: "https://app.maplebank.com/api/vendo/mcp" } },
    });
    const prm = await vendo.handler(root(PRM_PATH));
    expect((await prm.json() as { authorization_servers?: string[] }).authorization_servers).toEqual([issuer]);
    expect(await statusMcp(vendo)).toBe("broker");
    expect(requests).toHaveLength(0);
  });

  it("a localhost base URL skips the broker silently — the local door, no wire call", async () => {
    const { vendo, requests } = await composeVendo({ baseUrl: "http://localhost:3000" });
    const as = await vendo.handler(root("/.well-known/oauth-authorization-server/api/vendo/mcp"));
    expect(as.status).toBe(200);
    expect(await statusMcp(vendo)).toBe("local");
    expect(requests).toHaveLength(0);
  });

  it("no base URL at all skips the broker — the local door", async () => {
    const { vendo, requests } = await composeVendo({ baseUrl: null });
    const as = await vendo.handler(root("/.well-known/oauth-authorization-server/api/vendo/mcp"));
    expect(as.status).toBe(200);
    expect(await statusMcp(vendo)).toBe("local");
    expect(requests).toHaveLength(0);
  });
});
