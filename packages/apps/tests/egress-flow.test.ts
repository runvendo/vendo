import type { AppDocument, Guard, RunContext, ToolRegistry } from "@vendoai/core";
import { VENDO_APP_FORMAT } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createMachineLane } from "../src/box-lane.js";
import { createApps, type AppsConfig } from "../src/index.js";
import {
  fakeStatefulSandbox,
  guardFixture,
  memoryStore,
  seedAppRow,
} from "../src/testing/index.js";

/** execution-v2 Wave 2 Lane E — the grant flow end to end on the fake adapter:
    approve → the box door opens; unapproved → loud error; manifest growth
    re-prompts. The ctx-carrying doors that run the pre-flight are `box.request`
    and `machine.ping`; provisioning itself is the graduation lane's internal
    step (box-lane.ts), so it is set up here through the same composition. */

const tools: ToolRegistry = {
  async descriptors() {
    return [];
  },
  async execute() {
    return { status: "error", error: { code: "not-found", message: "no fixture tools" } };
  },
};

const context = (subject: string): RunContext => ({
  principal: { kind: "user", subject },
  venue: "app",
  presence: "present",
  sessionId: `session_${subject}`,
});

const app = (overrides: Partial<AppDocument> = {}): AppDocument => ({
  format: VENDO_APP_FORMAT,
  id: "app_egress_flow",
  name: "Egress flow fixture",
  ...overrides,
});

/** One fn call at the box door — the ctx-carrying door that runs the egress
 *  pre-flight before it wakes anything. */
const fnCall = { method: "POST", path: "/fn/run" } as const;

const setup = async (options: {
  doc?: AppDocument;
  implicitDomains?: string[];
  guard?: Guard;
} = {}) => {
  const store = memoryStore();
  const guard = options.guard ?? guardFixture();
  const sandbox = fakeStatefulSandbox();
  const doc = options.doc ?? app();
  await seedAppRow(store, doc, "user_ada");
  const config: AppsConfig = {
    store,
    guard,
    tools,
    catalog: [],
    machine: {
      sandbox,
      buildEnv: () => ({ PORT: "8080" }),
      ...(options.implicitDomains === undefined ? {} : { implicitDomains: options.implicitDomains }),
    },
  };
  const runtime = createApps(config);
  const stored = async (): Promise<AppDocument> => {
    const record = await store.records("vendo_apps").get(doc.id);
    if (record === null) throw new Error(`app row ${doc.id} is gone`);
    return (record.data as { doc: AppDocument }).doc;
  };
  const redeclare = async (egress: string[]): Promise<void> => {
    const record = await store.records("vendo_apps").get(doc.id);
    if (record === null) throw new Error(`app row ${doc.id} is gone`);
    const data = record.data as { subject: string; enabled: boolean; doc: AppDocument };
    await store.records("vendo_apps").put({
      id: doc.id,
      data: { ...data, doc: { ...data.doc, egress } },
      refs: { subject: data.subject },
    });
  };
  /** Graduation's own provision (box-lane.ts) over the SAME deployment config
   *  `createApps` composes its lifecycle from, so it boots under the runtime's
   *  own egress policy and the ref lands on the app row the runtime reads. */
  const provisionMachine = (): Promise<AppDocument> =>
    createMachineLane(config).lifecycle.provision(doc);
  return { store, guard, sandbox, runtime, doc, stored, redeclare, provisionMachine, ada: context("user_ada") };
};

const approveAndProvision = async (implicitDomains: string[] = ["host.vendo.test"]) => {
  const fixtureSetup = await setup({
    doc: app({ egress: ["api.example.com"] }),
    implicitDomains,
  });
  const { guard, runtime, doc, ada, provisionMachine } = fixtureSetup;
  const fixture = guard as ReturnType<typeof guardFixture>;
  await runtime.box.request(doc.id, fnCall, ada).catch(() => undefined);
  const approvalId = fixture.approvals[0]?.id;
  if (approvalId === undefined) throw new Error("no parked approval");
  fixture.decide(approvalId, true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await provisionMachine();
  return { ...fixtureSetup, fixture };
};

describe("egress grant flow: approve once, then open the box", () => {
  it("an unapproved declaration parks ONE approval card and refuses the box door loudly", async () => {
    const { guard, sandbox, runtime, doc, ada, stored } = await setup({
      doc: app({ egress: ["api.example.com", "hooks.stripe.com"] }),
    });
    const fixture = guard as ReturnType<typeof guardFixture>;

    await expect(runtime.box.request(doc.id, fnCall, ada)).rejects.toMatchObject({
      code: "blocked",
      message: expect.stringContaining("api.example.com"),
      detail: expect.objectContaining({
        status: "pending-approval",
        unapprovedDomains: ["api.example.com", "hooks.stripe.com"],
      }),
    });

    // No machine, no provider call, one parked card naming both domains.
    expect(sandbox.creates).toBe(0);
    expect((await stored()).machine).toBeUndefined();
    expect(fixture.approvals.length).toBe(1);
    expect(fixture.approvals[0]?.descriptor.name).toBe("vendo_egress_allow");
    expect(fixture.approvals[0]?.call.args).toEqual({
      appId: doc.id,
      domains: ["api.example.com", "hooks.stripe.com"],
    });
  });

  it("approving the card writes egressApproved and the machine boots with declaration + implicit skin domains", async () => {
    const { guard, sandbox, runtime, doc, ada, stored, provisionMachine } = await setup({
      doc: app({ egress: ["api.example.com"] }),
      implicitDomains: ["host.vendo.test"],
    });
    const fixture = guard as ReturnType<typeof guardFixture>;
    await expect(runtime.box.request(doc.id, fnCall, ada)).rejects.toMatchObject({ code: "blocked" });
    const approvalId = fixture.approvals[0]?.id;
    if (approvalId === undefined) throw new Error("no parked approval");

    fixture.decide(approvalId, true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect((await stored()).egressApproved).toEqual(["api.example.com"]);
    const provisioned = await provisionMachine();
    expect(provisioned.machine).toBeDefined();
    expect(sandbox.machines[0]?.allowedDomains).toEqual(["api.example.com", "host.vendo.test"]);
  });

  it("denial fails closed: nothing approved, and the next attempt re-prompts", async () => {
    const { guard, runtime, doc, ada, stored } = await setup({
      doc: app({ egress: ["api.example.com"] }),
    });
    const fixture = guard as ReturnType<typeof guardFixture>;
    await expect(runtime.box.request(doc.id, fnCall, ada)).rejects.toMatchObject({ code: "blocked" });
    const first = fixture.approvals[0]?.id;
    if (first === undefined) throw new Error("no parked approval");

    fixture.decide(first, false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await stored()).egressApproved).toBeUndefined();

    await expect(runtime.box.request(doc.id, fnCall, ada)).rejects.toMatchObject({ code: "blocked" });
    expect(fixture.approvals.length).toBe(1);
    expect(fixture.approvals[0]?.id).not.toBe(first);
  });

  it("an app declaring no egress boots with the implicit skin domains only (deny-by-default)", async () => {
    const { guard, sandbox, runtime, doc, ada, provisionMachine } = await setup({
      implicitDomains: ["host.vendo.test"],
    });
    const fixture = guard as ReturnType<typeof guardFixture>;
    await provisionMachine();
    // The door that would park a card runs clean end to end.
    await runtime.box.request(doc.id, fnCall, ada);
    expect(fixture.approvals.length).toBe(0);
    expect(sandbox.machines[0]?.allowedDomains).toEqual(["host.vendo.test"]);
  });

  it("a guard that pre-approves (action run) commits the grant without parking", async () => {
    const fixture = guardFixture();
    const preApproving: Guard = {
      ...fixture,
      async check(call, descriptor, ctx) {
        if (descriptor.name === "vendo_egress_allow") return { action: "run", decidedBy: "grant", grantId: "grant_std" };
        return fixture.check(call, descriptor, ctx);
      },
    };
    const { sandbox, runtime, doc, ada, stored, provisionMachine } = await setup({
      doc: app({ egress: ["api.example.com"] }),
      guard: preApproving,
    });
    // The pre-flight commits the grant inline; the door then fails only because
    // nothing has provisioned a machine for it to wake yet.
    await expect(runtime.box.request(doc.id, fnCall, ada)).rejects.toMatchObject({ code: "validation" });
    expect((await stored()).egressApproved).toEqual(["api.example.com"]);
    const provisioned = await provisionMachine();
    expect(provisioned.machine).toBeDefined();
    expect(sandbox.machines[0]?.allowedDomains).toEqual(["api.example.com"]);
  });
});

describe("egress grant flow: manifest growth re-prompts", () => {
  it("a declaration adding a domain blocks the next wake naming ONLY the new domain", async () => {
    const { fixture, runtime, doc, ada, redeclare } = await approveAndProvision();
    await redeclare(["api.example.com", "new.example.com"]);

    // `ping` wakes a sleeping machine, so it carries the same pre-flight.
    await expect(runtime.machine.ping(doc.id, ada)).rejects.toMatchObject({
      code: "blocked",
      detail: expect.objectContaining({ unapprovedDomains: ["new.example.com"] }),
    });
    const card = fixture.approvals[fixture.approvals.length - 1];
    expect(card?.call.args).toEqual({ appId: doc.id, domains: ["new.example.com"] });
  });

  it("approving the delta lets the wake resume with the widened allowlist", async () => {
    const { fixture, sandbox, runtime, doc, ada, redeclare, stored } = await approveAndProvision();
    await redeclare(["api.example.com", "new.example.com"]);
    await runtime.machine.ping(doc.id, ada).catch(() => undefined);
    const card = fixture.approvals[fixture.approvals.length - 1];
    if (card === undefined) throw new Error("no parked approval");

    fixture.decide(card.id, true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await stored()).egressApproved).toEqual(["api.example.com", "new.example.com"]);

    expect(await runtime.machine.ping(doc.id, ada)).toEqual({ state: "woke" });
    const raw = sandbox.machines[sandbox.machines.length - 1];
    // The snapshot carried the narrow list; the wake enforces the CURRENT one.
    expect(raw?.allowedDomains).toEqual(["api.example.com", "new.example.com", "host.vendo.test"]);
  });

  it("the box fn door rides the same pre-flight", async () => {
    const { runtime, doc, ada, redeclare } = await approveAndProvision();
    await redeclare(["api.example.com", "sneaky.example.com"]);
    await expect(runtime.box.request(doc.id, fnCall, ada)).rejects.toMatchObject({
      code: "blocked",
      detail: expect.objectContaining({ unapprovedDomains: ["sneaky.example.com"] }),
    });
  });
});

describe("egress grant hygiene", () => {
  it("a fork never carries the source's egress approval", async () => {
    const { fixture, runtime, ada } = await approveAndProvision();
    const fork = await runtime.fork("app_egress_flow", ada);
    expect(fork.egressApproved).toBeUndefined();
    expect(fork.egress).toEqual(["api.example.com"]);
    // The copy re-approves: knocking on its box door parks a fresh card.
    await expect(runtime.box.request(fork.id, fnCall, ada)).rejects.toMatchObject({
      code: "blocked",
      detail: expect.objectContaining({ unapprovedDomains: ["api.example.com"] }),
    });
    expect(fixture.approvals[fixture.approvals.length - 1]?.ctx.appId).toBe(fork.id);
  });
});

describe("egress grant state cannot be authored", () => {
  it("an engine-persisted edit cannot mint or widen egressApproved", async () => {
    // The persist seam pins grant state to the stored document; this drives
    // it through the same box.request path the runtime uses.
    const { runtime, doc, ada, stored, store } = await setup({
      doc: app({ egress: ["api.example.com"] }),
    });
    // Simulate a model-authored document arriving at the store WITH a forged
    // approval, then confirm the enforcement layers still treat the domain
    // as unapproved once the real persist seams have run: fork (a copy mint)
    // strips it, and the fork's box door re-prompts.
    const record = await store.records("vendo_apps").get(doc.id);
    if (record === null) throw new Error("app row is gone");
    const data = record.data as { subject: string; enabled: boolean; doc: AppDocument };
    await store.records("vendo_apps").put({
      id: doc.id,
      data: { ...data, doc: { ...data.doc, egressApproved: ["api.example.com"] } },
      refs: { subject: data.subject },
    });
    const fork = await runtime.fork(doc.id, ada);
    expect(fork.egressApproved).toBeUndefined();
    await expect(runtime.box.request(fork.id, fnCall, ada)).rejects.toMatchObject({
      code: "blocked",
      detail: expect.objectContaining({ unapprovedDomains: ["api.example.com"] }),
    });
    expect((await stored()).egressApproved).toEqual(["api.example.com"]); // untouched source
  });
});
