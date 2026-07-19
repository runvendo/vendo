import type { AppDocument, RunContext, ToolRegistry } from "@vendoai/core";
import { VENDO_APP_FORMAT } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createApps } from "./index.js";
import {
  guardFixture,
  memoryStore,
  seedAppRow,
} from "./testing/index.js";

// ENG-345 — guarded per-secret in-sandbox exposure toggle: the grant store and
// its approval flow. Option B (handles by default) stays the contract; the
// env-injection half of the feature (a granted secret's REAL value entering
// the box) rides the execution-v2 machine-env assembly and is covered by the
// secrets/egress lane — the v1 machine-cache injection tests died with it.

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
  const runtime = createApps({
    store,
    guard,
    tools,
    catalog: [],
  });
  return { store, guard, runtime };
};

/** A valid tree app owned by `subject`, declaring two secrets. */
const seedSecretApp = async (
  store: ReturnType<typeof memoryStore>,
  id: string,
  subject: string,
): Promise<AppDocument> => {
  const app: AppDocument = {
    format: VENDO_APP_FORMAT,
    id,
    name: "Payments",
    ui: "tree",
    tree: {
      formatVersion: "vendo-genui/v2",
      root: "root",
      nodes: [{ id: "root", component: "Text", props: { text: "Payments" } }],
    },
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

// ── Constraint 2 + 3 + (b): owner-only opt-in, high-risk approval, denial leaves OFF.
describe("ENG-345 constraint 2 & 3 & (b) — owner-only, approval-gated flip", () => {
  it("a non-owner cannot set or read the toggle", async () => {
    const { store, runtime } = setup();
    await seedSecretApp(store, "app_ada", "user_ada");
    const bob = context("user_bob");
    await expect(
      runtime.secrets.setExposure({ appId: "app_ada", secretName: "STRIPE_KEY", expose: true }, bob),
    ).rejects.toMatchObject({ code: "not-found" });
    await expect(runtime.secrets.exposure("app_ada", bob)).rejects.toMatchObject({ code: "not-found" });
  });

  it("rejects a secret the app never declared", async () => {
    const { store, runtime } = setup();
    await seedSecretApp(store, "app_ada", "user_ada");
    await expect(
      runtime.secrets.setExposure({ appId: "app_ada", secretName: "UNKNOWN", expose: true }, context("user_ada")),
    ).rejects.toMatchObject({ code: "validation" });
  });

  it("owner flip ON parks on a high-risk approval; a DENIED approval leaves it OFF", async () => {
    const { store, guard, runtime } = setup();
    await seedSecretApp(store, "app_ada", "user_ada");
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
    const { store, guard, runtime } = setup();
    await seedSecretApp(store, "app_ada", "user_ada");
    const ada = context("user_ada");
    await expose(runtime, guard, "app_ada", ada, "STRIPE_KEY");
    expect(await statusOf(runtime, "app_ada", ada, "STRIPE_KEY")).toBe("exposed");
    // OTHER was never touched — still a handle.
    expect(await statusOf(runtime, "app_ada", ada, "OTHER")).toBe("handle");
  });
});

// ── Constraint 5 + (e): the grant never travels with a copy.
describe("ENG-345 constraint 5 & (e) — the grant never travels with a copy", () => {
  it("fork, export→import, and a foreign import all revert to handles while the source stays exposed", async () => {
    const { store, guard, runtime } = setup();
    await seedSecretApp(store, "app_src", "user_ada");
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
    const { store, guard, runtime } = setup();
    await seedSecretApp(store, "app_gone", "user_ada");
    const ada = context("user_ada");
    await expose(runtime, guard, "app_gone", ada, "STRIPE_KEY");
    await runtime.delete("app_gone", ada);
    // Re-seed the SAME id: it must start with no exposure (grant did not survive delete).
    await seedSecretApp(store, "app_gone", "user_ada");
    expect(await statusOf(runtime, "app_gone", ada, "STRIPE_KEY")).toBe("handle");
  });
});

// ── Red-team matrix (explicit ship requirement; grant-store half).
describe("ENG-345 red-team — every bypass must fail", () => {
  it("rt2: a non-owner (remixer/co-user) cannot flip or inherit the toggle", async () => {
    const { store, runtime } = setup();
    await seedSecretApp(store, "app_rt2", "user_ada");
    const bob = context("user_bob");
    await expect(
      runtime.secrets.setExposure({ appId: "app_rt2", secretName: "STRIPE_KEY", expose: false }, bob),
    ).rejects.toMatchObject({ code: "not-found" });
    await expect(
      runtime.secrets.setExposure({ appId: "app_rt2", secretName: "STRIPE_KEY", expose: true }, bob),
    ).rejects.toMatchObject({ code: "not-found" });
  });

  it("rt3: flipping ON WITHOUT completing approval never exposes", async () => {
    const { store, runtime } = setup();
    await seedSecretApp(store, "app_rt3", "user_ada");
    const ada = context("user_ada");
    const parked = await runtime.secrets.setExposure({ appId: "app_rt3", secretName: "STRIPE_KEY", expose: true }, ada);
    expect(parked.status).toBe("pending-approval");
    // No decide() call — the grant stays pending, never active.
    expect(await statusOf(runtime, "app_rt3", ada, "STRIPE_KEY")).toBe("pending");
  });

  it("rt4: a grant for A never exposes B, and app X's grant never affects app Y", async () => {
    const { store, guard, runtime } = setup();
    await seedSecretApp(store, "app_x", "user_ada");
    await seedSecretApp(store, "app_y", "user_ada");
    const ada = context("user_ada");
    await expose(runtime, guard, "app_x", ada, "STRIPE_KEY");

    expect(await statusOf(runtime, "app_x", ada, "STRIPE_KEY")).toBe("exposed");
    expect(await statusOf(runtime, "app_x", ada, "OTHER")).toBe("handle"); // A's grant ≠ B
    expect(await statusOf(runtime, "app_y", ada, "STRIPE_KEY")).toBe("handle"); // X's grant ≠ Y
    expect(await statusOf(runtime, "app_y", ada, "OTHER")).toBe("handle");
  });

  it("rt5: revoking (flip OFF) an active grant reverts to handles", async () => {
    const { store, guard, runtime } = setup();
    await seedSecretApp(store, "app_rt5", "user_ada");
    const ada = context("user_ada");
    await expose(runtime, guard, "app_rt5", ada, "STRIPE_KEY");

    const off = await runtime.secrets.setExposure({ appId: "app_rt5", secretName: "STRIPE_KEY", expose: false }, ada);
    expect(off.status).toBe("handles");
    expect(await statusOf(runtime, "app_rt5", ada, "STRIPE_KEY")).toBe("handle");
  });
});
