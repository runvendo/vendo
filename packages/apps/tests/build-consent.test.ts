/**
 * S3 — consent. "No machine is ever spent without the user's explicit yes."
 *
 * Three things are pinned here, and the middle one is the slice's SEAM: the
 * guard's decision, on its own, is what starts a build. Everything on the
 * consent side is the real path — the real `vendo_make` front door, the real
 * propose door, the real parked-build collection over a real engine, the real
 * `onApprovalDecision` subscription, and the real app row. Only the two ends
 * are stand-ins, and both by design: the SCREEN agent (whose escalation is the
 * input) and the `AppBuilder` (whose lane is S4's).
 */
import {
  VENDO_APP_FORMAT,
  engineOverAdapter,
  type AppId,
  type FilesAdapter,
  type RunContext,
  type ToolRegistry,
} from "@vendoai/core";
import { describe, expect, it } from "vitest";
import {
  validateAppDocument,
  type AppBuilder,
  type BuildOutcome,
} from "../src/contract/index.js";
import { runMakeTool } from "../src/server/doors/make-tool.js";
import { readBundleBlob } from "../src/server/persistence/app-source.js";
import { createApps, type AppsConfig } from "../src/server/index.js";
import { fakeStatefulSandbox } from "../src/server/testing/fake-sandbox-stateful.js";
import { guardFixture } from "../src/server/testing/guard-fixture.js";
import { memoryStore } from "../src/server/testing/memory-store.js";
import type { AgentToolsDataDependencies } from "../src/server/doors/agent-tools.js";
import { PARKED_BUILD_COLLECTION } from "@vendoai/core";

const ctx: RunContext = {
  principal: { kind: "user", subject: "user_ada" },
  venue: "chat",
  presence: "present",
  sessionId: "session_ada",
};

const tools: ToolRegistry = {
  async descriptors() { return []; },
  async execute() {
    return { status: "error" as const, error: { code: "not-found", message: "no fixture tools" } };
  },
};

const ASK = "a photo editor that crops and rotates";

/** The screen agent escalates — the one input this slice's flow starts from. */
const screen: AgentToolsDataDependencies["screen"] = {
  async assemble() { return { kind: "escalate", why: "this needs a real image library" }; },
};

/** S4's lane, stood in for: it records the request it was handed and answers
 *  with whatever the case needs. The build seam is the ONE thing faked. */
const recordingBuilder = (outcome: BuildOutcome = { kind: "failed", why: "not built here" }): {
  builder: AppBuilder;
  built: { appId: AppId; prompt: string; why: string }[];
} => {
  const built: { appId: AppId; prompt: string; why: string }[] = [];
  return {
    built,
    builder: {
      available: () => true,
      async build(request) {
        built.push({ appId: request.appId, prompt: request.prompt, why: request.why });
        return outcome;
      },
    },
  };
};

const memoryBlobs = () => {
  const bytes = new Map<string, Uint8Array>();
  const adapter: FilesAdapter = {
    async put(key, value) { bytes.set(key, value); },
    async get(key) { const found = bytes.get(key); return found === undefined ? undefined : { bytes: found }; },
    async delete(key) { bytes.delete(key); },
  };
  return adapter;
};

const setup = (options: { build?: AppBuilder } = {}) => {
  const store = memoryStore();
  const files = memoryBlobs();
  const guard = guardFixture();
  const engine = engineOverAdapter(store);
  const config: AppsConfig = {
    store,
    guard,
    tools,
    catalog: [],
    screen,
    files,
    // A sandbox IS composed: this slice's law is that a composed sandbox is
    // still not spent until the person says yes, which a missing one would
    // prove nothing about.
    machine: { sandbox: fakeStatefulSandbox(), buildEnv: () => ({ PORT: "8080" }) },
    ...(options.build === undefined ? {} : { build: options.build }),
  };
  const runtime = createApps(config);
  const dependencies = {
    screen,
    claimSlot: async () => {},
    markUnbuilt: async () => {},
  } as unknown as AgentToolsDataDependencies;
  const make = () => runMakeTool(
    runtime,
    dependencies,
    { id: "call_make_1", tool: "vendo_make", args: { request: ASK } },
    ctx,
  );
  const rowOf = async (appId: string) => {
    const record = await store.records("vendo_apps").get(appId);
    return record === null ? null : (record.data as { doc: Record<string, unknown> }).doc;
  };
  return { store, guard, engine, files, runtime, make, rowOf };
};

const receiptOf = (outcome: Awaited<ReturnType<typeof runMakeTool>>): { id: string; status: string; say: string } => {
  if (outcome.status !== "ok") throw new Error(`expected ok, got ${outcome.status}`);
  return outcome.output as unknown as { id: string; status: string; say: string };
};

describe("propose spends no box", () => {
  it("raises the standing card, parks the build, and claims nothing", async () => {
    const { builder, built } = recordingBuilder();
    const { guard, engine, make, rowOf } = setup({ build: builder });

    const receipt = receiptOf(await make());

    expect(receipt.status).toBe("awaiting-consent");
    // The whole point: the turn ended with the box untouched.
    expect(built).toEqual([]);
    // One undecided card, and the ask verbatim on it.
    expect(guard.approvals).toHaveLength(1);
    expect(guard.approvals[0]?.call.args).toMatchObject({ appId: receipt.id, prompt: ASK });
    // Parked against that card, in the real collection.
    const parked = await engine.get(PARKED_BUILD_COLLECTION, guard.approvals[0]?.id ?? "");
    expect(parked?.data).toMatchObject({ appId: receipt.id, prompt: ASK, owner: "user_ada" });
    // The row says "offered, unanswered" — and never "building".
    const row = await rowOf(receipt.id);
    expect(row?.proposal).toMatchObject({ approvalId: guard.approvals[0]?.id, prompt: ASK });
    expect(row?.building).toBeUndefined();
  });
});

describe("the decision alone starts the build", () => {
  it("approving the standing card runs the builder and seals what it built", async () => {
    const entry = "app.js";
    const bytes = new TextEncoder().encode("console.log('built')");
    const { builder, built } = recordingBuilder({ kind: "built", files: [{ path: entry, bytes }], entry });
    const { guard, engine, files, make, rowOf } = setup({ build: builder });
    const receipt = receiptOf(await make());
    const approvalId = guard.approvals[0]?.id ?? "";
    expect(built).toEqual([]);

    // Nothing but the decision. No second tool call, no re-dispatch.
    guard.decide(approvalId, true);
    await new Promise((resolve) => setImmediate(resolve));

    expect(built).toEqual([{ appId: receipt.id, prompt: ASK, why: "this needs a real image library" }]);
    const row = await rowOf(receipt.id);
    expect(row?.ui).toBe("bundle");
    expect(row?.bundle).toMatchObject({ bytes: bytes.byteLength });
    // Sealed for real: the entry hash reads back as the bytes the builder made.
    const entryHash = (row?.bundle as { entry: string }).entry;
    expect(await readBundleBlob(receipt.id as AppId, entryHash, files)).toEqual(bytes);
    // Both build-state fields are gone: the app IS built now.
    expect(row?.proposal).toBeUndefined();
    expect(row?.building).toBeUndefined();
    // The parked record is cleared by the decision, either way.
    expect(await engine.get(PARKED_BUILD_COLLECTION, approvalId)).toBeNull();
  });

  it("denying it spends no box and leaves the honest failure card", async () => {
    const { builder, built } = recordingBuilder();
    const { guard, engine, make, rowOf } = setup({ build: builder });
    const receipt = receiptOf(await make());
    const approvalId = guard.approvals[0]?.id ?? "";

    guard.decide(approvalId, false);
    await new Promise((resolve) => setImmediate(resolve));

    expect(built).toEqual([]);
    const row = await rowOf(receipt.id);
    expect(row?.proposal).toBeUndefined();
    expect(row?.buildFailed).toMatchObject({ reason: expect.stringContaining("not approved") });
    expect(await engine.get(PARKED_BUILD_COLLECTION, approvalId)).toBeNull();
  });
});

describe("validateAppDocument refuses both build states at once", () => {
  const doc = (extra: Record<string, unknown>) => ({
    format: VENDO_APP_FORMAT,
    id: "app_two_states",
    name: "Two states",
    ...extra,
  });
  const proposal = {
    approvalId: "apr_1",
    prompt: ASK,
    why: "needs a real image library",
    at: "2026-08-24T00:00:00.000Z",
  };

  it("refuses a document carrying proposal AND building", () => {
    const result = validateAppDocument(doc({ proposal, building: "2026-08-24T00:00:01.000Z" }));
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error.message).toContain("proposal");
  });

  it("admits either one on its own", () => {
    expect(validateAppDocument(doc({ proposal })).ok).toBe(true);
    expect(validateAppDocument(doc({ building: "2026-08-24T00:00:01.000Z" })).ok).toBe(true);
  });
});
