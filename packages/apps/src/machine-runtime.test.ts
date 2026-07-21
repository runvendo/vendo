import type { AppDocument, RunContext, ToolRegistry } from "@vendoai/core";
import { VENDO_APP_FORMAT } from "@vendoai/core";
import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { createApps } from "./index.js";
import {
  fakeSandboxV2,
  guardFixture,
  memoryStore,
  seedAppRow,
  type FakeSandboxV2,
} from "./testing/index.js";

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
  const sandbox: FakeSandboxV2 = fakeSandboxV2();
  const doc = options.doc ?? app();
  await seedAppRow(store, doc, "user_ada");
  const runtime = createApps({
    store,
    guard,
    tools,
    catalog: [],
    // Wave 9 — the machine surface under test is flag-gated for NEW provisions.
    experimentalMachines: true,
    machine: {
      ...(options.withAdapter === false ? {} : { sandbox }),
      buildEnv: () => ({ PORT: "8080" }),
    },
  });
  return { store, guard, sandbox, runtime, doc, ada: context("user_ada") };
};

describe("apps runtime machine surface", () => {
  it("provisions, wakes, sleeps, and destroys through the runtime", async () => {
    const { sandbox, runtime, doc, ada } = await setup();

    const provisionedDoc = await runtime.machine.provision(doc.id, ada);
    expect(provisionedDoc.machine?.snapshotRef).toMatch(/^fake-v2:/);
    expect(sandbox.creates).toBe(1);

    const machine = await runtime.machine.wake(doc.id, ada);
    await machine.request({ method: "POST", path: "/state/k", body: "v" });

    const slept = await runtime.machine.sleep(doc.id, ada);
    expect(slept.machine?.snapshotRef).not.toBe(provisionedDoc.machine?.snapshotRef);

    const destroyed = await runtime.machine.destroy(doc.id, ada);
    expect(destroyed.machine).toBeUndefined();
    // Sleep released the provision-time snapshot; destroy released the slept one.
    expect(sandbox.destroyed).toEqual([
      provisionedDoc.machine?.snapshotRef,
      slept.machine?.snapshotRef,
    ]);

    const stored = await runtime.get(doc.id, ada);
    expect(stored?.machine).toBeUndefined();
  });

  it("enforces ownership on every machine operation", async () => {
    const { runtime, doc } = await setup();
    const grace = context("user_grace");
    for (const operation of [
      () => runtime.machine.provision(doc.id, grace),
      () => runtime.machine.wake(doc.id, grace),
      () => runtime.machine.sleep(doc.id, grace),
      () => runtime.machine.destroy(doc.id, grace),
    ]) {
      await expect(operation()).rejects.toMatchObject({ name: "VendoError", code: "not-found" });
    }
  });

  it("fails machine operations with sandbox-unavailable when no v2 adapter is configured", async () => {
    const { runtime, doc, ada } = await setup({ withAdapter: false });
    await expect(runtime.machine.provision(doc.id, ada)).rejects.toMatchObject({
      name: "VendoError",
      code: "sandbox-unavailable",
    });
  });
});

describe("delete destroys the machine", () => {
  it("destroys the provisioned sandbox when the app is deleted", async () => {
    const { sandbox, runtime, doc, ada } = await setup();
    const provisionedDoc = await runtime.machine.provision(doc.id, ada);

    await runtime.delete(doc.id, ada);

    expect(sandbox.destroyed).toEqual([provisionedDoc.machine?.snapshotRef]);
    expect(await runtime.get(doc.id, ada)).toBeNull();
  });

  it("stops a live machine on delete", async () => {
    const { sandbox, runtime, doc, ada } = await setup();
    await runtime.machine.provision(doc.id, ada);
    await runtime.machine.wake(doc.id, ada);

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
    const { runtime, doc, ada } = await setup();
    await runtime.machine.provision(doc.id, ada);

    const fork = await runtime.fork(doc.id, ada);

    expect(fork.machine).toBeUndefined();
    expect(fork.forkedFrom).toBe(doc.id);
    // The source keeps its machine; only the copy re-graduates on its own.
    const source = await runtime.get(doc.id, ada);
    expect(source?.machine?.snapshotRef).toMatch(/^fake-v2:/);
  });

  it("exportApp never exports a machine ref", async () => {
    const { runtime, doc, ada } = await setup();
    await runtime.machine.provision(doc.id, ada);

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
