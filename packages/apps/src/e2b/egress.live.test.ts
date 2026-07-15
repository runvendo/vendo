import type { AppDocument, SecretsProvider } from "@vendoai/core";
import type { AppDataAccess } from "../app-data.js";
import { describe, expect, it } from "vitest";
import { createAppsProxy } from "../proxy.js";
import { mintRunToken } from "../run-token.js";
import { e2bSandbox } from "./index.js";

// ============================================================================
// ENG-259 LIVE verification — gated on E2B_API_KEY (skipped when absent, exactly
// like e2b.live.test.ts). Proves the FUNCTIONAL egress path end-to-end against a
// real E2B machine and the real public network, using the DEFAULT node:dns SSRF
// resolver and DEFAULT global fetch (no injected fakes):
//
//   1. A real E2B sandbox created with an egress allowlist + a declared secret
//      HANDLE in env boots and carries the opaque handle (never the value).
//   2. The host-side proxy /egress route substitutes the real secret toward an
//      allowlisted host (proven via a reflect-then-redact echo), forwards, and
//      redacts the reflected secret from the response.
//   3. A non-allowlisted host is refused with no forward.
//   4. The real node:dns SSRF guard blocks the cloud metadata address.
//
// NOTE: first executed for real (keyed environment) in the ENG-290 live-lane
// milestone, which fixed the fixture handle nonce below; still SKIPPED without
// E2B_API_KEY.
// ============================================================================

const ALLOWED_HOST = "postman-echo.com"; // reflects request headers in its JSON response
const REAL_SECRET = `sk_live_${Math.random().toString(36).slice(2)}`;
// The nonce must be hex, like the runtime mints (machine.ts randomHex): the
// proxy's HANDLE_PATTERN only recognizes vendo-secret:<NAME>:<hex>. The first
// real run of this suite (ENG-290 live lanes) caught the old non-hex fixture
// "live0nonce" silently never substituting.
const HANDLE = "vendo-secret:ECHO_KEY:e2b259cafe";
const tokenSecret = new TextEncoder().encode("eng-259-live-egress-secret-key-01");

const app = {
  format: "vendo/app@1",
  id: "app_live_egress",
  name: "Live egress app",
  egress: [ALLOWED_HOST],
  secrets: ["ECHO_KEY"],
} as AppDocument;

const secrets: SecretsProvider = { async get(name) { return name === "ECHO_KEY" ? REAL_SECRET : undefined; } };

const proxy = createAppsProxy({
  tokenSecret,
  tools: { async descriptors() { return []; }, async execute() { return { status: "blocked", reason: "n/a" }; } },
  data: {} as AppDataAccess,
  owns: async () => true,
  loadApp: async () => app,
  secrets,
  // default fetch + default node:dns resolver — the real thing.
});

const runToken = async (): Promise<string> => mintRunToken(tokenSecret, {
  appId: app.id, subject: "user_live", runId: "run_live", presence: "present", expiresAt: Date.now() + 120_000,
  jti: "jti_live",
});

const egress = async (envelope: unknown): Promise<Response> => proxy.handler(new Request("https://proxy.test/egress", {
  method: "POST",
  headers: { authorization: `Bearer ${await runToken()}`, "content-type": "application/json" },
  body: JSON.stringify(envelope),
}));

describe.skipIf(!process.env.E2B_API_KEY)("ENG-259 functional secret egress (live)", () => {
  it("boots a real E2B machine that carries the secret HANDLE, not the value", async () => {
    const adapter = e2bSandbox({ apiKey: process.env.E2B_API_KEY, timeoutMs: 90_000 });
    const machine = await adapter.create({
      env: { PORT: "8080", ECHO_KEY: HANDLE },
      egress: [ALLOWED_HOST],
    });
    try {
      const printed = await machine.exec("printenv ECHO_KEY", { timeoutMs: 10_000 });
      expect(printed.stdout.trim()).toBe(HANDLE);
      expect(printed.stdout).not.toContain(REAL_SECRET);
    } finally {
      await machine.stop().catch(() => undefined);
    }
  }, 90_000);

  it("substitutes and forwards a real secret to an allowlisted host, redacting the reflection", async () => {
    const response = await egress({
      url: `https://${ALLOWED_HOST}/post`,
      method: "POST",
      headers: { authorization: `Bearer ${HANDLE}` },
      body: "hello",
    });
    expect(response.status).toBe(200);
    const envelope = await response.json() as { status: number; body: string };
    expect(envelope.status).toBe(200);
    // Reflect-then-redact: the echo saw the REAL value (so substitution happened), and the
    // proxy redacted it before returning — the handle is gone AND the real value is gone.
    expect(envelope.body).toContain("[vendo-secret-redacted]");
    expect(envelope.body).not.toContain(HANDLE);
    expect(envelope.body).not.toContain(REAL_SECRET);
  }, 30_000);

  it("refuses a non-allowlisted host with no substitution", async () => {
    const response = await egress({
      url: "https://example.com/collect",
      headers: { authorization: `Bearer ${HANDLE}` },
    });
    expect(response.status).toBe(403);
  }, 30_000);

  it("blocks the cloud metadata address via the real node:dns SSRF guard", async () => {
    // 169.254.169.254 is an IP literal, so this is refused pre-DNS; still exercises the guard live.
    const metadataApp = { ...app, egress: ["169.254.169.254"] } as AppDocument;
    const metadataProxy = createAppsProxy({
      tokenSecret,
      tools: { async descriptors() { return []; }, async execute() { return { status: "blocked", reason: "n/a" }; } },
      data: {} as AppDataAccess,
      owns: async () => true,
      loadApp: async () => metadataApp,
      secrets,
    });
    const response = await metadataProxy.handler(new Request("https://proxy.test/egress", {
      method: "POST",
      headers: { authorization: `Bearer ${await runToken()}`, "content-type": "application/json" },
      body: JSON.stringify({ url: "http://169.254.169.254/latest/meta-data/" }),
    }));
    expect(response.status).toBe(403);
  }, 30_000);
});
