import type { AppDocument, RunContext, ToolRegistry } from "@vendoai/core";
import { VENDO_APP_FORMAT } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createApps } from "./index.js";
import { documentFromRecord } from "./persistence.js";
import {
  fakeBoxSandbox,
  guardFixture,
  memoryStore,
  seedAppRow,
} from "./testing/index.js";

/** Wave 7 — env re-injection on grant change. Secrets land in the box env at
 *  provision and at the pre-edit re-injection; an ordinary wake resumes the
 *  SNAPSHOT's env (neither adapter re-injects at resume — e2b restores the
 *  process memory, Cloud resume sends only {ref, egress}). So a grant decided
 *  while a machine exists marks the machine env-stale; the next wake rebuilds
 *  the boundary env through the box control port (the harness restarts the
 *  app), and a RUNNING box is put to sleep at commit so the next request takes
 *  that wake path. */

const tools: ToolRegistry = {
  async descriptors() {
    return [];
  },
  async execute() {
    return { status: "error", error: { code: "not-found", message: "no fixture tools" } };
  },
};

const ada: RunContext = {
  principal: { kind: "user", subject: "user_ada" },
  venue: "app",
  presence: "present",
  sessionId: "session_user_ada",
};

const app = (): AppDocument => ({
  format: VENDO_APP_FORMAT,
  id: "app_grant_reinjection",
  name: "Grant re-injection fixture",
  secrets: ["STRIPE_KEY"],
});

const setup = async () => {
  const store = memoryStore();
  const guard = guardFixture();
  const sandbox = fakeBoxSandbox();
  const doc = app();
  await seedAppRow(store, doc, "user_ada");
  const runtime = createApps({
    store,
    guard,
    tools,
    catalog: [],
    machine: {
      sandbox,
      // The host assembler injects real values for granted secrets only —
      // the box env is the observable outcome of the whole grant flow.
      buildEnv: (_doc, grants) => ({
        PORT: "8080",
        ...(grants?.grantedSecrets.has("STRIPE_KEY") ? { STRIPE_KEY: "sk_live_real" } : {}),
      }),
    },
  });
  const grantStripe = async (): Promise<void> => {
    const pending = await runtime.secrets.setExposure(
      { appId: doc.id, secretName: "STRIPE_KEY", expose: true },
      ada,
    );
    if (pending.status !== "pending-approval") throw new Error(`unexpected status ${pending.status}`);
    guard.decide(pending.approvalId, true);
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const stored = async (): Promise<AppDocument> => {
    const record = await store.records("vendo_apps").get(doc.id);
    if (record === null) throw new Error("app row is gone");
    return documentFromRecord(record);
  };
  return { store, guard, sandbox, runtime, doc, grantStripe, stored };
};

describe("env re-injection on grant change (Wave 7)", () => {
  it("a secret granted while the machine slept lands at the next wake", async () => {
    const { sandbox, runtime, doc, grantStripe, stored } = await setup();
    await runtime.machine.provision(doc.id, ada);
    // Provision-time env: no grant, no value.
    expect(sandbox.machines[0]?.state.env.STRIPE_KEY).toBeUndefined();

    await grantStripe();
    // The grant marks the machine env-stale on the document (durable — any
    // process's next wake sees it).
    expect((await stored()).machine?.envStaleAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const machine = await runtime.machine.wake(doc.id, ada);
    // The wake resumed the snapshot (stale env) and rebuilt the boundary env
    // through the control port — the box now holds the real value.
    const raw = sandbox.machines.find((candidate) => candidate.id === machine.id);
    expect(raw?.state.env.STRIPE_KEY).toBe("sk_live_real");
    // The marker clears once the rebuild lands.
    expect((await stored()).machine?.envStaleAt).toBeUndefined();
  });

  it("a grant decided while the machine is RUNNING sleeps it; the next wake rebuilds", async () => {
    const { sandbox, runtime, doc, grantStripe, stored } = await setup();
    await runtime.machine.provision(doc.id, ada);
    const live = await runtime.machine.wake(doc.id, ada);
    const liveRaw = sandbox.machines.find((candidate) => candidate.id === live.id);
    expect(liveRaw?.state.env.STRIPE_KEY).toBeUndefined();

    await grantStripe();

    // The running box still held the old env — the commit put it to sleep so
    // the restart loop rides the ordinary wake path.
    expect(liveRaw?.stopped).toBe(true);
    const woken = await runtime.machine.wake(doc.id, ada);
    const wokenRaw = sandbox.machines.find((candidate) => candidate.id === woken.id);
    expect(wokenRaw?.state.env.STRIPE_KEY).toBe("sk_live_real");
    expect((await stored()).machine?.envStaleAt).toBeUndefined();
  });

  it("a revocation lands the same way: the next wake drops the value", async () => {
    const { sandbox, runtime, doc, grantStripe } = await setup();
    await grantStripe();
    await runtime.machine.provision(doc.id, ada);
    const granted = await runtime.machine.wake(doc.id, ada);
    expect(sandbox.machines.find((candidate) => candidate.id === granted.id)?.state.env.STRIPE_KEY)
      .toBe("sk_live_real");

    await runtime.secrets.setExposure({ appId: doc.id, secretName: "STRIPE_KEY", expose: false }, ada);

    const woken = await runtime.machine.wake(doc.id, ada);
    const raw = sandbox.machines.find((candidate) => candidate.id === woken.id);
    // The boundary env is REPLACED (the harness restarts the app with exactly
    // the injected set), so the revoked value is gone, not merged over.
    expect(raw?.state.env.STRIPE_KEY).toBeUndefined();
  });

  it("an ordinary wake with no grant change never touches the control port", async () => {
    const { sandbox, runtime, doc } = await setup();
    await runtime.machine.provision(doc.id, ada);
    const machine = await runtime.machine.wake(doc.id, ada);
    // No stale marker → the resume alone is the wake; env stays snapshot-borne.
    const raw = sandbox.machines.find((candidate) => candidate.id === machine.id);
    expect(raw?.state.env).toEqual({ PORT: "8080" });
  });
});
