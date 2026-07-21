import type { AppDocument, RunContext, ToolRegistry } from "@vendoai/core";
import { VENDO_APP_FORMAT } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createApps } from "./index.js";
import {
  fakeSandboxV2,
  guardFixture,
  memoryStore,
  seedAppRow,
} from "./testing/index.js";

/** execution-v2 Wave 2 Lane E — per-app secret grants decide which keys the
    env assembler may inject: the runtime resolves the active grants and hands
    them to the host's buildEnv at every provision. */

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
  id: "app_secret_injection",
  name: "Secret injection fixture",
  secrets: ["STRIPE_KEY", "UNGRANTED_KEY"],
});

const setup = async () => {
  const store = memoryStore();
  const guard = guardFixture();
  const sandbox = fakeSandboxV2();
  const doc = app();
  await seedAppRow(store, doc, "user_ada");
  const runtime = createApps({
    store,
    guard,
    tools,
    catalog: [],
    experimentalMachines: true,
    machine: {
      sandbox,
      // The host assembler sees exactly the grant set the runtime resolved;
      // echoing it into env makes the injection decision observable.
      buildEnv: (_doc, grants) => ({
        PORT: "8080",
        GRANTED: [...(grants?.grantedSecrets ?? [])].sort().join(","),
      }),
    },
  });
  return { guard, sandbox, runtime, doc };
};

describe("secret grants feed the machine env assembly", () => {
  it("no grants → the assembler sees an empty granted set", async () => {
    const { sandbox, runtime, doc } = await setup();
    await runtime.machine.provision(doc.id, ada);
    expect(sandbox.machines[0]?.env.GRANTED).toBe("");
  });

  it("an approved exposure grant reaches the assembler; ungranted names never do", async () => {
    const { guard, sandbox, runtime, doc } = await setup();

    // Turning a secret on is the guard's high-risk approval flow (ENG-345).
    const pending = await runtime.secrets.setExposure(
      { appId: doc.id, secretName: "STRIPE_KEY", expose: true },
      ada,
    );
    if (pending.status !== "pending-approval") throw new Error(`unexpected status ${pending.status}`);
    guard.decide(pending.approvalId, true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    await runtime.machine.provision(doc.id, ada);
    expect(sandbox.machines[0]?.env.GRANTED).toBe("STRIPE_KEY");
  });
});
