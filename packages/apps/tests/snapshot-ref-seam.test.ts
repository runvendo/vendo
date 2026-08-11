/**
 * The snapshot-ref seam: an adapter MINTS a ref, the app document STORES it,
 * and an adapter DECODES it back on the next wake. Three parties, and the only
 * thing that keeps them agreeing is the ref's shape — so this suite drives the
 * real e2b adapter into the real row writer and back out through the real row
 * reader, with no stub anywhere on that path. The e2b SDK is mocked because it
 * is the PROVIDER (the machine at the far end), not the counterparty of this
 * seam: the producer of a ref and its consumer are both the real adapter here.
 *
 * The Cloud half of the same seam is tested against the real Cloud adapter in
 * `packages/vendo/tests/sandbox.test.ts` — `@vendoai/apps` cannot import it
 * (the umbrella sits above this block).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VENDO_APP_FORMAT, engineOverAdapter } from "@vendoai/core";
import { e2bSandbox } from "../src/server/escalation/e2b/index.js";
import type { EngineOps } from "../src/server/persistence/engine.js";
import { APPS_COLLECTION, appRecordInput, rowFromRecord, updateAppRow } from "../src/server/persistence/persistence.js";
import { memoryStore } from "../src/server/testing/memory-store.js";
import type { AppDocument } from "../src/contract/index.js";

const APP = "app_seam";
const SUBJECT = "user_1";
const PROVISIONED_AT = "2026-08-11T00:00:00.000Z";

const sdk = vi.hoisted(() => {
  const sandbox = {
    sandboxId: "sandbox_seam_123",
    getHost: vi.fn((port: number) => `${port}-sandbox_seam_123.e2b.app`),
    createSnapshot: vi.fn(async () => ({ snapshotId: "snapshot_seam_789" })),
    pause: vi.fn(async () => true),
    kill: vi.fn(async () => true),
    setTimeout: vi.fn(async () => undefined),
    isRunning: vi.fn(async () => true),
    commands: { run: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })) },
    files: {
      read: vi.fn(async () => new Uint8Array()),
      write: vi.fn(async () => undefined),
      list: vi.fn(async () => []),
    },
  };
  return {
    sandbox,
    create: vi.fn(async () => sandbox),
    staticKill: vi.fn(async () => true),
    deleteSnapshot: vi.fn(async () => true),
  };
});

class FakeNotFoundError extends Error {}

vi.mock("e2b", () => ({
  ALL_TRAFFIC: "0.0.0.0/0",
  NotFoundError: FakeNotFoundError,
  Sandbox: {
    create: sdk.create,
    kill: sdk.staticKill,
    deleteSnapshot: sdk.deleteSnapshot,
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
});

const seeded = (): AppDocument => ({
  format: VENDO_APP_FORMAT,
  id: APP,
  name: "Seam",
  tree: {
    formatVersion: "vendo-genui/v2",
    root: "root",
    nodes: [{ id: "root", component: "Text", props: { text: "Seam" } }],
  },
} as AppDocument);

/** An engine with the app row already written through the real writer. */
const seededApps = async (): Promise<EngineOps> => {
  const engine = engineOverAdapter(memoryStore());
  await engine.put(APPS_COLLECTION, appRecordInput(seeded(), SUBJECT, false, "box"));
  return engine;
};

/** A Cloud composite ref of the real shape (`sandbox-wire.ts`): what the
 *  console-backed adapter writes into a document. */
const cloudRef = (): string => `vendo:v2:${Buffer.from(JSON.stringify({
  version: 2,
  machineId: "m_00000000000000000000cloud",
  ref: `vendo:snap_${"a".repeat(40)}`,
  port: 8080,
})).toString("base64url")}`;

describe("the snapshot-ref seam: mint → row → wake", () => {
  it("carries a ref the real adapter minted through the real row writer and back into a real resume", async () => {
    const engine = await seededApps();
    const adapter = e2bSandbox({ apiKey: "key_test" });
    const machine = await adapter.create({ env: { PORT: "8080" }, allowedDomains: ["api.example.com"] });
    const minted = await machine.snapshot();

    // Producer side: the real row writer (admission → validation → store), the
    // same path machine-lifecycle's sleep and provision flows take.
    const written = await updateAppRow(
      engine,
      APP,
      (document) => ({ ...document, machine: { snapshotRef: minted, provisionedAt: PROVISIONED_AT } }),
      "box",
    );
    expect(written.machine?.snapshotRef).toBe(minted);

    // Consumer side: the real row reader, then the real adapter decoding what
    // came back out of the store — not the string the producer kept in hand.
    const stored = rowFromRecord((await engine.get(APPS_COLLECTION, APP))!).doc.machine!.snapshotRef;
    expect(stored).toBe(minted);
    await adapter.resume(stored);
    expect(sdk.create).toHaveBeenLastCalledWith("snapshot_seam_789", expect.objectContaining({
      network: { allowOut: ["api.example.com"], denyOut: ["0.0.0.0/0"] },
    }));
  });

  it("refuses another provider's ref out of a legacy row, naming both providers, before any provider call", async () => {
    const engine = await seededApps();
    // The legacy row: a Cloud-minted ref sitting in an app the host now resumes
    // with the e2b adapter. Written before validation could tell the difference,
    // so it is forced in with the row shape the reader expects.
    const document = { ...seeded(), machine: { snapshotRef: cloudRef(), provisionedAt: PROVISIONED_AT } };
    await engine.put(APPS_COLLECTION, { id: APP, data: { subject: SUBJECT, enabled: false, doc: document }, refs: { subject: SUBJECT } });

    const stored = rowFromRecord((await engine.get(APPS_COLLECTION, APP))!).doc.machine!.snapshotRef;
    const adapter = e2bSandbox({ apiKey: "key_test" });
    const foreign = {
      code: "validation",
      message: "This snapshot was minted by Vendo Cloud, but the resuming sandbox is E2B. A snapshot cannot move between providers — resume it with the same sandbox that made it (pass sandbox: cloudSandbox()), or rebuild the app on E2B.",
    };
    await expect(adapter.resume(stored)).rejects.toMatchObject(foreign);
    await expect(adapter.destroy(stored)).rejects.toMatchObject(foreign);
    // Nothing reached the provider: a ref this adapter cannot read never
    // becomes a machine, a kill, or a snapshot deletion.
    expect(sdk.create).not.toHaveBeenCalled();
    expect(sdk.staticKill).not.toHaveBeenCalled();
    expect(sdk.deleteSnapshot).not.toHaveBeenCalled();
  });

  it("tells a raw provider snapshot id apart from a truncated one", async () => {
    const adapter = e2bSandbox({ apiKey: "key_test" });

    await expect(adapter.resume("e2b:snap_0000000000000000000000000000000000000000")).rejects.toMatchObject({
      code: "validation",
      message: 'This is a raw E2B snapshot id, not a sandbox snapshot reference. Snapshot references start with "e2b:v2:" and carry the source sandbox id alongside the snapshot. Rebuild the app to mint a current reference.',
    });

    const cut = Buffer.from(JSON.stringify({
      version: 2,
      snapshotId: "snapshot_seam_789",
      sourceSandboxId: "sandbox_seam_123",
      port: 8080,
    })).toString("base64url").slice(0, 40);
    await expect(adapter.resume(`e2b:v2:${cut}`)).rejects.toMatchObject({
      code: "validation",
      // The LENGTH is the evidence; the payload itself never reaches the message.
      message: `E2B snapshot reference is truncated or corrupt: ${cut.length} characters after the "e2b:v2:" prefix, expected 100-400. The stored reference was cut off — rebuild the app.`,
    });

    // The scheme is the ONE piece of a caller's ref that reaches a message, so
    // it is bounded: an unbounded capture made a 200k-character lead a
    // 200k-character error and a 200k-character log line. It is not a scheme.
    await expect(adapter.resume(`${"a".repeat(200_000)}:x`)).rejects.toMatchObject({
      code: "validation",
      message: 'This is not a sandbox snapshot reference: E2B snapshot references start with "e2b:v2:". Rebuild the app to mint a current reference.',
    });
    expect(sdk.create).not.toHaveBeenCalled();
  });
});
