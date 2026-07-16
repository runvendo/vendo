import type { AppDocument, AuditEvent, RunContext, ToolRegistry } from "@vendoai/core";
import { VENDO_APP_FORMAT } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createApps } from "./index.js";
import { createMachineSessions } from "./machine.js";
import { substituteSecretHandles } from "./egress.js";
import {
  FakeSandboxMachine,
  basicLanguageModel,
  fakeSandbox,
  guardFixture,
  memoryStore,
  seedAppRow,
  type FakeSandboxAdapter,
} from "./testing/index.js";

// ENG-345 — guarded per-secret in-sandbox exposure toggle. The five locked
// constraints, each with the test that proves it, plus the required red-team
// pass. Option B (handles + egress substitution) stays the DEFAULT throughout;
// this toggle is the OFF-by-default exception path.

const SECRET_VALUES: Record<string, string> = {
  STRIPE_KEY: "sk_live_REALSECRET",
  OTHER: "other_real_value",
};
const secrets = { get: async (name: string): Promise<string | undefined> => SECRET_VALUES[name] };

const tools: ToolRegistry = {
  async descriptors() { return []; },
  async execute() { return { status: "error", error: { code: "not-found", message: "no tools" } }; },
};

const context = (subject: string): RunContext => ({
  principal: { kind: "user", subject },
  venue: "app",
  presence: "present",
  sessionId: `session_${subject}`,
});

const HANDLE = /^vendo-secret:[A-Za-z_][A-Za-z0-9_]*:[0-9a-f]+$/;

const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const waitFor = async (predicate: () => Promise<boolean>): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("waitFor timed out");
};

const setup = () => {
  const store = memoryStore();
  const guard = guardFixture();
  const sandbox = fakeSandbox();
  const runtime = createApps({
    store,
    guard,
    tools,
    sandbox,
    catalog: [],
    secrets,
    model: basicLanguageModel(),
  });
  return { store, guard, sandbox, runtime };
};

/** A valid rung-2 (tree + server) app owned by `subject`, declaring two secrets. */
const seedServedApp = async (
  store: ReturnType<typeof memoryStore>,
  sandbox: FakeSandboxAdapter,
  id: string,
  subject: string,
): Promise<AppDocument> => {
  const machine = await sandbox.create({ env: { PORT: "8080" } });
  const server = await machine.snapshot();
  await machine.stop();
  const app: AppDocument = {
    format: VENDO_APP_FORMAT,
    id,
    name: "Payments",
    ui: "tree",
    tree: {
      formatVersion: "vendo-genui/v1",
      root: "root",
      nodes: [{ id: "root", component: "Text", props: { text: "Payments" } }],
    },
    server,
    secrets: ["STRIPE_KEY", "OTHER"],
    egress: ["api.stripe.com"],
  };
  await seedAppRow(store, app, subject);
  return app;
};

const statusOf = async (
  runtime: ReturnType<typeof setup>["runtime"],
  appId: string,
  ctx: RunContext,
  secretName: string,
): Promise<string> => {
  const states = await runtime.secrets.exposure(appId, ctx);
  return states.find((state) => state.secretName === secretName)?.status ?? "missing";
};

const exposedRunEvents = (audit: AuditEvent[]): AuditEvent[] =>
  audit.filter((event) => (event.detail as { operation?: string } | undefined)?.operation === "secret-exposed-run");

/** Drive the owner-approved ON flip end to end. */
const expose = async (
  runtime: ReturnType<typeof setup>["runtime"],
  guard: ReturnType<typeof guardFixture>,
  appId: string,
  ctx: RunContext,
  secretName: string,
): Promise<void> => {
  const result = await runtime.secrets.setExposure({ appId, secretName, expose: true }, ctx);
  if (result.status !== "pending-approval") throw new Error(`expected pending-approval, got ${result.status}`);
  guard.decide(result.approvalId, true);
  await waitFor(async () => await statusOf(runtime, appId, ctx, secretName) === "exposed");
};

// ── Constraint 1 + (a): Option B is the default; no opt-in → handle in sandbox env.
describe("ENG-345 constraint 1 & (a) — Option B default: no grant leaves a handle in-sandbox", () => {
  it("machine env carries an opaque handle, not the value, when nothing is exposed", async () => {
    const sandbox = fakeSandbox();
    const machines = createMachineSessions({
      sandbox,
      tokenSecret: new Uint8Array(32),
      secrets,
      resolveExposedSecrets: async () => new Set<string>(),
      reportExposedRun: async () => undefined,
    });
    const app: AppDocument = {
      format: VENDO_APP_FORMAT,
      id: "app_default",
      name: "n",
      ui: "http",
      secrets: ["STRIPE_KEY", "OTHER"],
    };
    await machines.withMachine(app, context("user_ada"), async ({ machine }) => {
      const env = (machine as FakeSandboxMachine).env;
      expect(env.STRIPE_KEY).toMatch(HANDLE);
      expect(env.OTHER).toMatch(HANDLE);
      expect(JSON.stringify(env)).not.toContain(SECRET_VALUES.STRIPE_KEY);
    });
  });

  it("open() over an ungranted served app emits no exposed-run audit", async () => {
    const { store, guard, sandbox, runtime } = setup();
    await seedServedApp(store, sandbox, "app_plain", "user_ada");
    guard.audit.length = 0;
    await runtime.open("app_plain", context("user_ada"));
    expect(exposedRunEvents(guard.audit)).toHaveLength(0);
  });
});

// ── Constraint 2 + 3 + (b): owner-only opt-in, high-risk approval, denial leaves OFF.
describe("ENG-345 constraint 2 & 3 & (b) — owner-only, approval-gated flip", () => {
  it("a non-owner cannot set or read the toggle", async () => {
    const { store, sandbox, runtime } = setup();
    await seedServedApp(store, sandbox, "app_ada", "user_ada");
    const bob = context("user_bob");
    await expect(
      runtime.secrets.setExposure({ appId: "app_ada", secretName: "STRIPE_KEY", expose: true }, bob),
    ).rejects.toMatchObject({ code: "not-found" });
    await expect(runtime.secrets.exposure("app_ada", bob)).rejects.toMatchObject({ code: "not-found" });
  });

  it("rejects a secret the app never declared", async () => {
    const { store, sandbox, runtime } = setup();
    await seedServedApp(store, sandbox, "app_ada", "user_ada");
    await expect(
      runtime.secrets.setExposure({ appId: "app_ada", secretName: "UNKNOWN", expose: true }, context("user_ada")),
    ).rejects.toMatchObject({ code: "validation" });
  });

  it("owner flip ON parks on a high-risk approval; a DENIED approval leaves it OFF", async () => {
    const { store, guard, sandbox, runtime } = setup();
    await seedServedApp(store, sandbox, "app_ada", "user_ada");
    const ada = context("user_ada");

    const parked = await runtime.secrets.setExposure({ appId: "app_ada", secretName: "STRIPE_KEY", expose: true }, ada);
    expect(parked.status).toBe("pending-approval");
    // The flip rode the guard's CRITICAL approval flow (constraint 3).
    expect(guard.approvals.some((approval) => approval.descriptor.critical === true)).toBe(true);
    expect(await statusOf(runtime, "app_ada", ada, "STRIPE_KEY")).toBe("pending");

    if (parked.status !== "pending-approval") throw new Error("unreachable");
    guard.decide(parked.approvalId, false);
    await flush();
    expect(await statusOf(runtime, "app_ada", ada, "STRIPE_KEY")).toBe("handle");
  });

  it("owner flip ON becomes exposed only after the approval is APPROVED", async () => {
    const { store, guard, sandbox, runtime } = setup();
    await seedServedApp(store, sandbox, "app_ada", "user_ada");
    const ada = context("user_ada");
    await expose(runtime, guard, "app_ada", ada, "STRIPE_KEY");
    expect(await statusOf(runtime, "app_ada", ada, "STRIPE_KEY")).toBe("exposed");
    // OTHER was never touched — still a handle.
    expect(await statusOf(runtime, "app_ada", ada, "OTHER")).toBe("handle");
  });
});

// ── Constraint (c): ON+approved injects the REAL value into sandbox env.
describe("ENG-345 (c) — an active grant injects the real value into sandbox env", () => {
  it("machine env carries the real value for the granted secret and a handle for the rest", async () => {
    const sandbox = fakeSandbox();
    const machines = createMachineSessions({
      sandbox,
      tokenSecret: new Uint8Array(32),
      secrets,
      resolveExposedSecrets: async () => new Set(["STRIPE_KEY"]),
      reportExposedRun: async () => undefined,
    });
    const app: AppDocument = {
      format: VENDO_APP_FORMAT,
      id: "app_exposed",
      name: "n",
      ui: "http",
      secrets: ["STRIPE_KEY", "OTHER"],
    };
    await machines.withMachine(app, context("user_ada"), async ({ machine }) => {
      const env = (machine as FakeSandboxMachine).env;
      expect(env.STRIPE_KEY).toBe(SECRET_VALUES.STRIPE_KEY); // exception path
      expect(env.OTHER).toMatch(HANDLE); // still the default
    });
  });
});

// ── Constraint 4 + (d): one audit event per run that executes with an exposed secret.
describe("ENG-345 constraint 4 & (d) — one exposed-run audit per run", () => {
  it("emits exactly one exposed-run event per run.mint, and none once machine-backed is false", async () => {
    const sandbox = fakeSandbox();
    const reported: string[][] = [];
    const machines = createMachineSessions({
      sandbox,
      tokenSecret: new Uint8Array(32),
      secrets,
      resolveExposedSecrets: async () => new Set(["STRIPE_KEY"]),
      reportExposedRun: async (_app, _ctx, names) => { reported.push(names); },
    });
    const httpApp: AppDocument = {
      format: VENDO_APP_FORMAT, id: "app_http", name: "n", ui: "http", secrets: ["STRIPE_KEY"],
    };
    await machines.withMachine(httpApp, context("user_ada"), async () => undefined);
    expect(reported).toEqual([["STRIPE_KEY"]]);

    // A rung-1 tree app has no machine → an exposure grant exposes nothing → no audit.
    const treeApp: AppDocument = {
      format: VENDO_APP_FORMAT, id: "app_tree", name: "n", ui: "tree", secrets: ["STRIPE_KEY"],
    };
    reported.length = 0;
    await machines.withMachine(treeApp, context("user_ada"), async () => undefined);
    expect(reported).toEqual([]);
  });

  it("runtime open() emits one exposed-run event carrying the exposed secret name", async () => {
    const { store, guard, sandbox, runtime } = setup();
    await seedServedApp(store, sandbox, "app_srv", "user_ada");
    const ada = context("user_ada");
    await expose(runtime, guard, "app_srv", ada, "STRIPE_KEY");

    guard.audit.length = 0;
    await runtime.open("app_srv", ada);
    const first = exposedRunEvents(guard.audit);
    expect(first).toHaveLength(1);
    expect((first[0]?.detail as { secrets?: string[] }).secrets).toEqual(["STRIPE_KEY"]);
    expect(first[0]?.appId).toBe("app_srv");

    await runtime.open("app_srv", ada);
    expect(exposedRunEvents(guard.audit)).toHaveLength(2);
  });
});

// ── Constraint 5 + (e): copies ALWAYS revert to handles — the grant never travels.
describe("ENG-345 constraint 5 & (e) — the grant never travels with a copy", () => {
  it("fork, export→import, and a foreign import all revert to handles while the source stays exposed", async () => {
    const { store, guard, sandbox, runtime } = setup();
    await seedServedApp(store, sandbox, "app_src", "user_ada");
    const ada = context("user_ada");
    await expose(runtime, guard, "app_src", ada, "STRIPE_KEY");

    // fork
    const forked = await runtime.fork("app_src", ada);
    const forkStates = await runtime.secrets.exposure(forked.id, ada);
    expect(forkStates.every((state) => state.status === "handle")).toBe(true);

    // export → import (same owner)
    const bytes = await runtime.exportApp("app_src", ada);
    const imported = await runtime.importApp(bytes, ada);
    expect(imported.id).not.toBe("app_src");
    expect((await runtime.secrets.exposure(imported.id, ada)).every((state) => state.status === "handle")).toBe(true);

    // import by a DIFFERENT principal (a remixer) — cannot inherit the grant
    const bob = context("user_bob");
    const importedByBob = await runtime.importApp(bytes, bob);
    expect((await runtime.secrets.exposure(importedByBob.id, bob)).every((state) => state.status === "handle")).toBe(true);

    // the ORIGINAL app is still exposed — the copies did not disturb it
    expect(await statusOf(runtime, "app_src", ada, "STRIPE_KEY")).toBe("exposed");
  });

  it("deleting an app clears its exposure grants (no orphan can bind a re-minted id)", async () => {
    const { store, guard, sandbox, runtime } = setup();
    await seedServedApp(store, sandbox, "app_gone", "user_ada");
    const ada = context("user_ada");
    await expose(runtime, guard, "app_gone", ada, "STRIPE_KEY");
    await runtime.delete("app_gone", ada);
    // Re-seed the SAME id: it must start with no exposure (grant did not survive delete).
    await seedServedApp(store, sandbox, "app_gone", "user_ada");
    expect(await statusOf(runtime, "app_gone", ada, "STRIPE_KEY")).toBe("handle");
  });
});

// ── Red-team matrix (explicit ship requirement).
describe("ENG-345 red-team — every bypass must fail", () => {
  it("rt1: a shared/imported copy cannot carry the grant (covered above, asserted here on a fresh id)", async () => {
    const { store, guard, sandbox, runtime } = setup();
    await seedServedApp(store, sandbox, "app_rt1", "user_ada");
    const ada = context("user_ada");
    await expose(runtime, guard, "app_rt1", ada, "STRIPE_KEY");
    const copy = await runtime.importApp(await runtime.exportApp("app_rt1", ada), ada);
    // The copy's machine env is handle-only because its fresh id has no grant.
    const machines = createMachineSessions({
      sandbox,
      tokenSecret: new Uint8Array(32),
      secrets,
      resolveExposedSecrets: async (app) => new Set((await runtime.secrets.exposure(app.id, ada))
        .filter((state) => state.status === "exposed").map((state) => state.secretName)),
      reportExposedRun: async () => undefined,
    });
    await machines.withMachine(
      { format: VENDO_APP_FORMAT, id: copy.id, name: "n", ui: "http", secrets: ["STRIPE_KEY"] },
      ada,
      async ({ machine }) => {
        expect((machine as FakeSandboxMachine).env.STRIPE_KEY).toMatch(HANDLE);
      },
    );
  });

  it("rt2: a non-owner (remixer/co-user) cannot flip or inherit the toggle", async () => {
    const { store, sandbox, runtime } = setup();
    await seedServedApp(store, sandbox, "app_rt2", "user_ada");
    const bob = context("user_bob");
    await expect(
      runtime.secrets.setExposure({ appId: "app_rt2", secretName: "STRIPE_KEY", expose: false }, bob),
    ).rejects.toMatchObject({ code: "not-found" });
    await expect(
      runtime.secrets.setExposure({ appId: "app_rt2", secretName: "STRIPE_KEY", expose: true }, bob),
    ).rejects.toMatchObject({ code: "not-found" });
  });

  it("rt3: flipping ON WITHOUT completing approval never exposes", async () => {
    const { store, guard, sandbox, runtime } = setup();
    await seedServedApp(store, sandbox, "app_rt3", "user_ada");
    const ada = context("user_ada");
    const parked = await runtime.secrets.setExposure({ appId: "app_rt3", secretName: "STRIPE_KEY", expose: true }, ada);
    expect(parked.status).toBe("pending-approval");
    // No decide() call — grant stays pending. A run must not expose.
    guard.audit.length = 0;
    await runtime.open("app_rt3", ada);
    expect(exposedRunEvents(guard.audit)).toHaveLength(0);
    expect(await statusOf(runtime, "app_rt3", ada, "STRIPE_KEY")).toBe("pending");
  });

  it("rt4: a grant for A never exposes B, and app X's grant never affects app Y", async () => {
    const { store, guard, sandbox, runtime } = setup();
    await seedServedApp(store, sandbox, "app_x", "user_ada");
    await seedServedApp(store, sandbox, "app_y", "user_ada");
    const ada = context("user_ada");
    await expose(runtime, guard, "app_x", ada, "STRIPE_KEY");

    expect(await statusOf(runtime, "app_x", ada, "STRIPE_KEY")).toBe("exposed");
    expect(await statusOf(runtime, "app_x", ada, "OTHER")).toBe("handle"); // A's grant ≠ B
    expect(await statusOf(runtime, "app_y", ada, "STRIPE_KEY")).toBe("handle"); // X's grant ≠ Y
    expect(await statusOf(runtime, "app_y", ada, "OTHER")).toBe("handle");
  });

  it("rt5: revoking (flip OFF) an active grant reverts to handles and stops exposing", async () => {
    const { store, guard, sandbox, runtime } = setup();
    await seedServedApp(store, sandbox, "app_rt5", "user_ada");
    const ada = context("user_ada");
    await expose(runtime, guard, "app_rt5", ada, "STRIPE_KEY");

    const off = await runtime.secrets.setExposure({ appId: "app_rt5", secretName: "STRIPE_KEY", expose: false }, ada);
    expect(off.status).toBe("handles");
    expect(await statusOf(runtime, "app_rt5", ada, "STRIPE_KEY")).toBe("handle");

    guard.audit.length = 0;
    await runtime.open("app_rt5", ada);
    expect(exposedRunEvents(guard.audit)).toHaveLength(0);
  });

  it("rt6: egress substitution + redaction (§4.5) still holds when exposure is ON", async () => {
    // Exposure changes ONLY the boot env; the egress proxy boundary is unchanged.
    // The allowlisted-host substitution still maps handle→value, and a
    // non-allowlisted host still fails closed (the value never egresses).
    const handleMap = { "vendo-secret:STRIPE_KEY:nonce": SECRET_VALUES.STRIPE_KEY };
    const allowed = substituteSecretHandles(
      { url: "https://api.stripe.com/charge", headers: { authorization: "Bearer vendo-secret:STRIPE_KEY:nonce" } },
      handleMap,
      ["api.stripe.com"],
    );
    expect(allowed.headers?.authorization).toBe(`Bearer ${SECRET_VALUES.STRIPE_KEY}`);

    const blocked = substituteSecretHandles(
      { url: "https://evil.test/collect", body: "vendo-secret:STRIPE_KEY:nonce" },
      handleMap,
      ["api.stripe.com"],
    );
    expect(blocked.body).toBe("vendo-secret:STRIPE_KEY:nonce");
    expect(JSON.stringify(blocked)).not.toContain(SECRET_VALUES.STRIPE_KEY);
  });
});
