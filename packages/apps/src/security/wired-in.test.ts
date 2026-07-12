import type { RunContext, SecretsProvider } from "@vendoai/core";
import { describe, expect, it, vi } from "vitest";
import { createApps } from "../index.js";
import {
  basicLanguageModel,
  fakeSandbox,
  guardFixture,
  memoryStore,
  seedAppRow,
} from "../testing/index.js";

// ============================================================================
// KEY RED-TEAM FINDING FOR SECRETS (documented, then proven):
//
// machine.ts `environment()` injects each declared secret into the sandbox as an
// OPAQUE HANDLE string `vendo-secret:<name>:<nonce>` — NOT the real value. The real
// secret value is never placed in the machine's env, files, or any request the app
// can read. The SecretsProvider.get() is not even consulted at boot.
//
// substituteSecretHandles (see egress-exfil.test.ts) is a PURE helper that a sandbox
// egress adapter *could* call to swap a handle for its value on an allowlisted host.
// But in the OSS e2b/modal path that helper is NOT wired in: nothing calls it, so the
// real secret value is never present inside the sandbox at all. Exfiltration is
// therefore impossible BY CONSTRUCTION — strictly stronger than the contract's
// allowlist-gated substitution, because there is no value to exfiltrate.
//
// This test proves the injected-handle property end-to-end via the real createApps
// open() path with a fake sandbox.
// ============================================================================

const ctx: RunContext = {
  principal: { kind: "user", subject: "user_ada" },
  venue: "chat",
  presence: "present",
  sessionId: "session_ada",
};

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
