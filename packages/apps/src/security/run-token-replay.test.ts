import type { AppDocument, RunContext, ToolRegistry } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createAppData } from "../app-data.js";
import { createMachineSessions } from "../machine.js";
import { createAppsProxy } from "../proxy.js";
import { createRunTokenGate } from "../run-token-gate.js";
import { fakeSandbox, memoryStore } from "../testing/index.js";

// ENG-251 anti-replay regression pin. A run token is a bearer credential the
// sandbox reuses for every proxy callback over one run, so it CANNOT be
// single-use per call (proxy/e2e tests reuse one token across many calls). What
// must hold is revocation-on-teardown: once a run's machine is evicted, a replay
// of its captured token — still unexpired, still HMAC-valid — is rejected.

const ctx: RunContext = {
  principal: { kind: "user", subject: "user_ada" },
  venue: "app",
  presence: "present",
  sessionId: "session_ada",
};

const app: AppDocument = { format: "vendo/app@1", id: "app_replay", name: "Replay" };

const inertTools: ToolRegistry = {
  async descriptors() { return []; },
  async execute() { return { status: "blocked", reason: "no" }; },
};

const stateGet = (token: string): Request =>
  new Request("https://proxy.test/state", { headers: { authorization: `Bearer ${token}` } });

describe("run token replay revocation (ENG-251)", () => {
  it("rejects a replayed run token once its run's machine is torn down, within TTL", async () => {
    const tokenSecret = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const consumedRunTokens = createRunTokenGate();
    const machines = createMachineSessions({
      sandbox: fakeSandbox(),
      proxyUrl: "https://proxy.test",
      tokenSecret,
      consumedRunTokens,
    });
    const proxy = createAppsProxy({
      tokenSecret,
      tools: inertTools,
      data: createAppData(memoryStore()),
      owns: async () => true,
      loadApp: async () => app,
      consumedRunTokens,
    });

    // Boot a live machine and capture the run token now in its env; the machine
    // stays live after withMachine returns (no stop), exactly as a real run does.
    const token = await machines.withMachine(app, ctx, async (run) => run.runToken);

    // While the run is live the token authenticates MANY callbacks — a run
    // legitimately makes repeated tool/state/egress calls on one token, so the
    // anti-replay must NOT be single-use-per-call (that would break /egress).
    for (let i = 0; i < 3; i += 1) {
      expect((await proxy.handler(stateGet(token))).status).toBe(200);
    }

    // Tear the run down: the machine cache burns the run's jti.
    await machines.evict(app.id);

    // The captured token still verifies (HMAC + TTL) but is now revoked.
    const replay = await proxy.handler(stateGet(token));
    expect(replay.status).toBe(401);
    expect(await replay.json()).toMatchObject({ error: { code: "unauthorized" } });
  });

  it("without the shared gate, the same replay would still succeed (guards the guard)", async () => {
    // Same flow, but the proxy has no gate — proving the rejection above is the
    // anti-replay check and not some incidental teardown side effect.
    const tokenSecret = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const machines = createMachineSessions({ sandbox: fakeSandbox(), proxyUrl: "https://proxy.test", tokenSecret });
    const proxy = createAppsProxy({
      tokenSecret,
      tools: inertTools,
      data: createAppData(memoryStore()),
      owns: async () => true,
      loadApp: async () => app,
    });
    const token = await machines.withMachine(app, ctx, async (run) => run.runToken);
    await machines.evict(app.id);
    expect((await proxy.handler(stateGet(token))).status).toBe(200);
  });
});

describe("createRunTokenGate", () => {
  it("consumes idempotently and evicts the oldest jti past its cap", () => {
    const gate = createRunTokenGate(2);
    gate.consume("a");
    gate.consume("a"); // idempotent
    expect(gate.isConsumed("a")).toBe(true);
    gate.consume("b");
    gate.consume("c"); // over cap → oldest ("a") evicted
    expect(gate.isConsumed("a")).toBe(false);
    expect(gate.isConsumed("b")).toBe(true);
    expect(gate.isConsumed("c")).toBe(true);
  });
});
