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
  VendoError,
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
import { bundleDocument, createBuildDoor } from "../src/server/doors/build-door.js";
import { APPS_COLLECTION } from "../src/server/persistence/persistence.js";
import { runMakeTool } from "../src/server/doors/make-tool.js";
import { readBundleBlob } from "../src/server/persistence/app-source.js";
import { createApps, type AppsConfig } from "../src/server/index.js";
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

const setup = (options: { build?: AppBuilder; files?: false } = {}) => {
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
    ...(options.files === false ? {} : { files }),
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

describe("the gate refuses a build this deployment could never seal", () => {
  it("is unavailable with a builder but no files adapter, so no card is ever raised", async () => {
    // `seal` needs somewhere to put the bytes. Without it the yes was spent on a
    // build that throws at the seal, so the ask must not be put at all.
    const { builder, built } = recordingBuilder();
    const { guard, make } = setup({ build: builder, files: false });

    const receipt = receiptOf(await make());

    expect(receipt.status).toBe("failed");
    expect(receipt.say).toContain("build machine");
    expect(guard.approvals).toEqual([]);
    expect(built).toEqual([]);
  });
});

/** The row a refusal lands on is read at the moment it lands on it. A detached
 *  lane's watchdog fires minutes after `resume` began, by which time the row may
 *  have been sealed by the very build it was meant to catch — or deleted. */
describe("a refusal reads the row it is refusing", () => {
  type Engine = ReturnType<typeof engineOverAdapter>;
  /** The one seam a case can use to move the row WHILE the build is in the box. */
  const laneThat = (
    work: (engine: Engine, appId: AppId) => Promise<void>,
    outcome: BuildOutcome,
  ): { builder: AppBuilder; bind(engine: Engine): void } => {
    let engine: Engine | undefined;
    return {
      bind(next) { engine = next; },
      builder: {
        available: () => true,
        async build(request) {
          if (engine !== undefined) await work(engine, request.appId);
          return outcome;
        },
      },
    };
  };
  const patchDoc = async (engine: Engine, appId: AppId, patch: Record<string, unknown>): Promise<void> => {
    const record = await engine.get(APPS_COLLECTION, appId);
    if (record === null) return;
    const data = record.data as { doc: Record<string, unknown> };
    await engine.put(APPS_COLLECTION, { ...record, data: { ...data, doc: { ...data.doc, ...patch } } });
  };
  /** Drive one consented build to its terminal landing. */
  const ran = async (lane: ReturnType<typeof laneThat>) => {
    const composed = setup({ build: lane.builder });
    lane.bind(composed.engine);
    const receipt = receiptOf(await composed.make());
    composed.guard.decide(composed.guard.approvals[0]?.id ?? "", true);
    await new Promise((resolve) => setImmediate(resolve));
    return await composed.rowOf(receipt.id);
  };

  it("leaves a SEALED app alone when the refusal lands after the seal", async () => {
    const bundle = { entry: "a".repeat(64), bytes: 4, sealedAt: "2026-08-24T00:00:00.000Z" };
    const row = await ran(laneThat(
      async (engine, appId) => patchDoc(engine, appId, { ui: "bundle", bundle }),
      { kind: "failed", why: "the build never finished" },
    ));

    // The app the person owns survives a refusal that arrived after it: the
    // bundle is theirs, and only the build state goes.
    expect(row?.bundle).toMatchObject({ entry: bundle.entry });
    expect(row?.buildFailed).toBeUndefined();
    expect(row?.building).toBeUndefined();
  });

  it("never resurrects an app that was DELETED while its build ran", async () => {
    const row = await ran(laneThat(
      async (engine, appId) => { await engine.delete(APPS_COLLECTION, appId); },
      { kind: "failed", why: "the box went away" },
    ));

    // A deleted app can never mount again (apps-surface.ts). A failure card put
    // back at its id is an app the person deleted, standing again.
    expect(row).toBeNull();
  });

  it("a seal clears a failure an earlier terminal write already recorded", async () => {
    const entry = "app.js";
    const bytes = new TextEncoder().encode("console.log('built')");
    // The watchdog tombstoned this row while the box was still working, and the
    // box then came back with a real bundle. Only one of the two is the truth.
    const row = await ran(laneThat(
      async (engine, appId) => patchDoc(engine, appId, {
        buildFailed: { reason: "never finished", at: "2026-08-24T00:00:00.000Z" },
      }),
      { kind: "built", files: [{ path: entry, bytes }], entry },
    ));

    expect(row?.bundle).toBeDefined();
    // A built app is not a failed one: the slot reads `buildFailed` and would
    // show the failure card over a bundle that landed.
    expect(row?.buildFailed).toBeUndefined();
  });
});

describe("bundleDocument cannot be closed early by the bundle's own text", () => {
  const decoder = new TextDecoder();
  const documentFor = (source: string) => decoder.decode(bundleDocument(new TextEncoder().encode(source)));

  it("escapes every case of a script end tag, because the HTML parser matches them all", () => {
    // HTML5 §13.2.6.4 matches the script end tag ASCII-case-insensitively, so a
    // bundle carrying "</SCRIPT>" in a string literal closes the inline script
    // exactly as a lowercase one does.
    for (const closing of ["</script>", "</SCRIPT>", "</Script>", "</ScRiPt>"]) {
      const html = documentFor(`const markup = "${closing}";`);
      expect(html, closing).toContain("<\\/");
      // One opening tag, one closing tag: the document the frame boots.
      expect(html.match(/<\/script/gu), closing).toHaveLength(1);
    }
  });

  it("keeps the bundle's own bytes, case and all — only the slash is escaped", () => {
    // The escape lives inside a JavaScript string literal, so lowercasing it
    // would change what the app renders.
    expect(documentFor('const markup = "</SCRIPT>";')).toContain('"<\\/SCRIPT>"');
  });
});

describe("propose never lets its cleanup hide the write that failed", () => {
  it("throws the original error even when abandonApprovals throws too", async () => {
    const parkFailure = new VendoError("unavailable", "the store said no");
    const door = createBuildDoor({
      config: {
        guard: {
          async check() {
            return { action: "ask" as const, approval: { id: "apr_1" } };
          },
          async abandonApprovals() { throw new Error("the guard is down too"); },
        },
      },
      parkedBuilds: { async put() { throw parkFailure; } },
    } as unknown as Parameters<typeof createBuildDoor>[0]);

    // The abandon is best-effort cleanup for a card nobody needs. Its own
    // failure must not become the answer the caller reacts to.
    await expect(door.propose({ appId: "app_x" as AppId, name: "X", prompt: ASK, why: "y" }, ctx))
      .rejects.toThrow(parkFailure);
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
