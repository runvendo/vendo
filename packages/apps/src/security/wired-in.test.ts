import type { AppDocument, RunContext, SecretsProvider } from "@vendoai/core";
import { describe, expect, it, vi } from "vitest";
import { createApps } from "../index.js";
import { createAppsProxy } from "../proxy.js";
import { mintRunToken } from "../run-token.js";
import type { AppDataAccess } from "../app-data.js";
import type { IpResolver } from "../ssrf.js";
import {
  basicLanguageModel,
  fakeSandbox,
  guardFixture,
  memoryStore,
  seedAppRow,
} from "../testing/index.js";

// ============================================================================
// SECRETS INVARIANT (ENG-259, updated from the pre-hardening "dead code" framing):
//
//   Real secret values resolve ONLY inside the proxy process, ONLY for egress toward
//   an allowlisted host. They NEVER enter the sandbox: the machine's env carries only
//   opaque per-boot handles (`vendo-secret:<name>:<nonce>`), and boot never reads the
//   SecretsProvider.
//
// This replaces the earlier claim that substituteSecretHandles was unreachable dead
// code ("safe by construction because nothing calls it"). It is now WIRED: the apps
// proxy /egress route builds a handle→value map at request time and calls it — but
// only after the host has passed the declared egress allowlist and the SSRF guard, so
// a secret is read only when egress is actually permitted. Two properties, both proven
// below: (1) the sandbox holds handles, not values, and boot does not read secrets;
// (2) the proxy resolves a secret only for allowlisted egress, never otherwise.
// ============================================================================

const ctx: RunContext = {
  principal: { kind: "user", subject: "user_ada" },
  venue: "chat",
  presence: "present",
  sessionId: "session_ada",
};

const tokenSecret = new TextEncoder().encode("wired-in-secrets-invariant-key-01");
const publicResolver: IpResolver = async () => ["93.184.216.34"];

describe("secret handles are injected, real values never enter the sandbox", () => {
  it("boots a machine whose env carries handles, not secret values, and never reads the provider", async () => {
    const REAL_VALUE = "sk_live_MUST_NOT_APPEAR";
    const get = vi.fn(async (): Promise<string | undefined> => REAL_VALUE);
    const secrets: SecretsProvider = { get };
    const sandbox = fakeSandbox();
    const store = memoryStore();
    const runtime = createApps({
      store,
      guard: guardFixture(),
      tools: { async descriptors() { return []; }, async execute() { return { status: "blocked", reason: "no" }; } },
      sandbox,
      secrets,
      catalog: [],
      model: basicLanguageModel(),
    });

    const app = await runtime.create({ prompt: "Secret app" }, ctx);
    await seedAppRow(store, { ...app, ui: "http", secrets: ["STRIPE_KEY", "RESEND_KEY"] }, ctx.principal.subject);

    await runtime.open(app.id, ctx);
    await vi.waitFor(() => expect(sandbox.machines.size).toBe(1));
    const env = [...sandbox.machines.values()].at(-1)!.env;

    // Each declared secret is an opaque, per-boot nonce'd handle.
    expect(env.STRIPE_KEY).toMatch(/^vendo-secret:STRIPE_KEY:[0-9a-f]{8}$/);
    expect(env.RESEND_KEY).toMatch(/^vendo-secret:RESEND_KEY:[0-9a-f]{8}$/);

    // The real value is nowhere in the machine environment...
    expect(Object.values(env)).not.toContain(REAL_VALUE);
    // ...and the boot path never even asked the SecretsProvider for it.
    expect(get).not.toHaveBeenCalled();
  });
});

describe("the proxy resolves a secret ONLY for allowlisted egress", () => {
  const REAL = "sk_live_PROXY_ONLY";
  const app = { format: "vendo/app@1", id: "app_wired", name: "Wired", egress: ["api.stripe.com"], secrets: ["STRIPE_KEY"] } as AppDocument;

  const proxyWith = (fetchMock: typeof globalThis.fetch, resolveIp: IpResolver, get: SecretsProvider["get"]) =>
    createAppsProxy({
      tokenSecret,
      tools: { async descriptors() { return []; }, async execute() { return { status: "blocked", reason: "no" }; } },
      data: {} as AppDataAccess,
      owns: async () => true,
      loadApp: async () => app,
      secrets: { get },
      fetch: fetchMock,
      resolveIp,
    });

  const token = async () => mintRunToken(tokenSecret, {
    appId: app.id, subject: "user_ada", runId: "run_wired", presence: "present", expiresAt: Date.now() + 60_000,
    jti: "jti_wired",
  });

  const call = (bearer: string, url: string): Request => new Request("https://proxy.test/egress", {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify({ url, method: "POST", headers: { authorization: "Bearer vendo-secret:STRIPE_KEY:abc123" } }),
  });

  it("reads and substitutes the secret toward an allowlisted host", async () => {
    const get = vi.fn(async () => REAL);
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof globalThis.fetch;
    const proxy = proxyWith(fetchMock, publicResolver, get);
    await proxy.handler(call(await token(), "https://api.stripe.com/v1/charges"));
    expect(get).toHaveBeenCalledWith("STRIPE_KEY");
    const headers = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${REAL}`);
  });

  it("never reads the secret toward a non-allowlisted host", async () => {
    const get = vi.fn(async () => REAL);
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof globalThis.fetch;
    const proxy = proxyWith(fetchMock, publicResolver, get);
    const response = await proxy.handler(call(await token(), "https://evil.example/collect"));
    expect(response.status).toBe(403);
    expect(get).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
