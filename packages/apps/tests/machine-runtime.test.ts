import {
  type RunContext,
  type ToolRegistry,
  VENDO_APP_FORMAT,
} from "@vendoai/core";
import type {
  AppDocument,
} from "../src/contract/index.js";
import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { createMachineLane } from "../src/server/escalation/box-lane.js";
import { createApps, type AppsConfig } from "../src/server/index.js";
import { fakeStatefulSandbox, type FakeStatefulSandbox } from "../src/server/testing/fake-sandbox-stateful.js";
import { guardFixture } from "../src/server/testing/guard-fixture.js";
import { memoryStore } from "../src/server/testing/memory-store.js";
import { seedAppRow } from "../src/server/testing/seed-app-row.js";

const decoder = new TextDecoder();

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
  id: "app_machine_runtime",
  name: "Machine runtime fixture",
  ...overrides,
});

const setup = async (options: {
  doc?: AppDocument;
  withAdapter?: boolean;
} = {}) => {
  const store = memoryStore();
  const guard = guardFixture();
  const sandbox: FakeStatefulSandbox = fakeStatefulSandbox();
  const doc = options.doc ?? app();
  await seedAppRow(store, doc, "user_ada");
  const config: AppsConfig = {
    store,
    guard,
    tools,
    catalog: [],
    machine: {
      ...(options.withAdapter === false ? {} : { sandbox }),
      buildEnv: () => ({ PORT: "8080" }),
    },
  };
  const runtime = createApps(config);
  /** Graduation's own provision (box-lane.ts) over the SAME deployment config
   *  `createApps` composes its lifecycle from — the ref lands on the app row,
   *  so the runtime's own lifecycle reads it back. Provision is only SETUP for
   *  the doors below; machine-lifecycle.test.ts owns the round trip itself. */
  const provisionMachine = (): Promise<AppDocument> =>
    createMachineLane(config).lifecycle.provision(doc);
  return { store, guard, sandbox, runtime, doc, provisionMachine, ada: context("user_ada") };
};

describe("apps runtime machine surface", () => {
  it("enforces ownership on the machine door", async () => {
    const { runtime, doc, provisionMachine, ada } = await setup();
    await provisionMachine();

    // `ping` is the ctx-taking machine door: a stranger is masked with
    // not-found, and the owner's identical call proves the door works.
    await expect(runtime.machine.ping(doc.id, context("user_grace")))
      .rejects.toMatchObject({ name: "VendoError", code: "not-found" });
    expect(await runtime.machine.ping(doc.id, ada)).toEqual({ state: "woke" });
  });
});

describe("delete destroys the machine", () => {
  it("destroys the provisioned sandbox when the app is deleted", async () => {
    const { sandbox, runtime, doc, provisionMachine, ada } = await setup();
    const provisionedDoc = await provisionMachine();

    await runtime.delete(doc.id, ada);

    expect(sandbox.destroyed).toEqual([provisionedDoc.machine?.snapshotRef]);
    expect(await runtime.get(doc.id, ada)).toBeNull();
  });

  it("stops a live machine on delete", async () => {
    const { sandbox, runtime, doc, provisionMachine, ada } = await setup();
    await provisionMachine();
    // The machine has to be live on the RUNTIME's OWN lifecycle for delete to
    // find it, so the wake rides a production door — ping wakes on the way to
    // its keepalive HEAD.
    await runtime.machine.ping(doc.id, ada);

    await runtime.delete(doc.id, ada);

    expect(sandbox.machines.every((machine) => machine.stopped)).toBe(true);
  });

  it("leaves layer-1 app deletion untouched by the machine path", async () => {
    const { sandbox, runtime, doc, ada } = await setup({ withAdapter: false });
    await runtime.delete(doc.id, ada);
    expect(sandbox.destroyed).toEqual([]);
    expect(await runtime.get(doc.id, ada)).toBeNull();
  });
});

describe("fork, export, and import never carry a machine", () => {
  it("fork copies the document without the machine", async () => {
    const { runtime, doc, provisionMachine, ada } = await setup();
    await provisionMachine();

    const fork = await runtime.fork(doc.id, ada);

    expect(fork.machine).toBeUndefined();
    expect(fork.forkedFrom).toBe(doc.id);
    // The source keeps its machine; only the copy re-graduates on its own.
    const source = await runtime.get(doc.id, ada);
    expect(source?.machine?.snapshotRef).toMatch(/^fake-v2:/);
  });

  it("exportApp never exports a machine ref", async () => {
    const { runtime, doc, provisionMachine, ada } = await setup();
    await provisionMachine();

    const archive = unzipSync(await runtime.exportApp(doc.id, ada));
    const exported = JSON.parse(decoder.decode(archive["app.json"])) as Record<string, unknown>;

    expect("machine" in exported).toBe(false);
  });

  it("importApp strips a machine ref smuggled into the document", async () => {
    const { runtime, ada } = await setup();

    const imported = await runtime.importApp(
      app({
        id: "app_smuggled",
        machine: { snapshotRef: "e2b:snap_stolen", provisionedAt: "2026-07-19T00:00:00.000Z" },
      }),
      ada,
    );

    expect(imported.machine).toBeUndefined();
    const stored = await runtime.get(imported.id, ada);
    expect(stored?.machine).toBeUndefined();
  });
});
