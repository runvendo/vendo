import {
  VENDO_APP_FORMAT,
  type AppDocument,
  type RunContext,
  type ToolRegistry,
} from "@vendoai/core";
import { describe, expect, it, vi } from "vitest";
import { createApps, type SandboxAdapter } from "./index.js";
import {
  fakeSandbox,
  guardFixture,
  memoryStore,
  scriptedLanguageModel,
  seedAppRow,
  type MachineApp,
  type ScriptedModelCall,
} from "./testing/index.js";

/**
 * E2E of the ladder + invisible-graduation invariants (06-apps §2), driven end to
 * end through the public createApps → AppsRuntime surface against the in-repo core
 * seam implementations (real StoreAdapter, Guard, and SandboxAdapter — the neighbors
 * the apps layer is architecturally allowed to compose with) plus a scripted model.
 * Real side effects are asserted through the store seam (vendo_apps rows, the app
 * blob namespace) and real HTTP through the fake machine's request path.
 */

const tools: ToolRegistry = {
  async descriptors() { return []; },
  async execute() { return { status: "error", error: { code: "not-found", message: "no tools" } }; },
};

const ctx = (subject = "user_ada", presence: RunContext["presence"] = "present"): RunContext => ({
  principal: { kind: "user", subject },
  venue: "app",
  presence,
  sessionId: `session_${subject}`,
});

const decoder = new TextDecoder();

const promptText = (call: ScriptedModelCall): string =>
  call.prompt
    .map((message) => typeof message.content === "string"
      ? message.content
      : message.content.map((part) => part.text ?? "").join(""))
    .join("\n");

const instructionOf = (text: string): string => /INSTRUCTION:\s*(.*)/.exec(text)?.[1] ?? "";

/** A scripted model that drives create → rung-2 → rung-3 escalations by dialect + instruction. */
const ladderModel = () => scriptedLanguageModel((call) => {
  const text = promptText(call);
  if (text.includes("TASK: CREATE_APP")) {
    return JSON.stringify({
      name: "Ladder app",
      description: "climbs the ladder",
      tree: {
        formatVersion: "vendo-genui/v1",
        root: "root",
        nodes: [{ id: "root", component: "Text", source: "prewired", props: { text: "Rung 1" } }],
      },
    });
  }
  // TASK: EDIT_CODE — branch on the human instruction (the system prompt itself
  // always mentions "server-computed", so we must read the INSTRUCTION line only).
  if (instructionOf(text).includes("computed")) {
    return JSON.stringify({ rung: 3, files: [{ path: "/app/view.js", content: "export const view = 1;" }] });
  }
  return JSON.stringify({ rung: 2, files: [{ path: "/app/server.js", content: "export const server = 1;" }] });
});

const storedServer = async (
  store: ReturnType<typeof memoryStore>,
  appId: string,
): Promise<string | undefined> => {
  const record = await store.records("vendo_apps").get(appId);
  return (record?.data as { doc: AppDocument }).doc.server;
};

describe("ladder rung transitions (e2e)", () => {
  it("opens a non-empty generated surface after an in-place tree edit through the real runtime", async () => {
    const store = memoryStore();
    const runtime = createApps({
      store,
      guard: guardFixture(),
      tools,
      catalog: [],
      model: scriptedLanguageModel(
        JSON.stringify({
          name: "Editable dashboard",
          tree: {
            formatVersion: "vendo-genui/v1",
            root: "root",
            nodes: [
              { id: "root", component: "Stack", source: "prewired", children: ["title"] },
              { id: "title", component: "Text", source: "prewired", props: { text: "Spending" } },
            ],
          },
        }),
        JSON.stringify({
          ops: [
            {
              op: "add-component",
              name: "SpendingChart",
              source: "export default function SpendingChart() { return <div role=\"img\">Chart</div>; }",
            },
            {
              op: "add-node",
              node: { id: "chart", component: "SpendingChart", source: "generated" },
              parentId: "root",
            },
          ],
        }),
      ),
    });
    const ada = ctx();
    const app = await runtime.create({ prompt: "Build a spending summary" }, ada);

    const edited = await runtime.edit(app.id, "Add a visual dashboard with a chart", ada);
    const surface = await runtime.open(app.id, ada);

    expect(edited.app.id).toBe(app.id);
    expect(edited.failure).toBeUndefined();
    expect(surface).toMatchObject({
      kind: "tree",
      payload: {
        root: "root",
        nodes: expect.arrayContaining([
          expect.objectContaining({ id: "chart", component: "SpendingChart", source: "generated" }),
        ]),
        components: { SpendingChart: expect.stringContaining("Chart") },
      },
    });
  });

  it("walks rung 1 → 2 → 3 through edit() while open() always answers from last state", async () => {
    const store = memoryStore();
    const sandbox = fakeSandbox();
    const runtime = createApps({ store, guard: guardFixture(), tools, sandbox, catalog: [], model: ladderModel() });
    const ada = ctx();

    // Rung 1 — instant, jailed, no machine.
    const created = await runtime.create({ prompt: "Show a greeting" }, ada);
    expect(created.ui).toBe("tree");
    expect(created.server).toBeUndefined();
    expect(await runtime.open(created.id, ada)).toMatchObject({ kind: "tree", payload: { formatVersion: "vendo-genui/v1" } });
    expect(await storedServer(store, created.id)).toBeUndefined();

    // Rung 2 — tree + server. UI stays the instant path; a fn: ref now reaches the machine.
    const toServer = await runtime.edit(created.id, "Add a server backend to persist data", ada);
    expect(toServer.issues).toBeUndefined();
    expect(toServer.version.rung).toBe(2);
    const rung2Server = await storedServer(store, created.id);
    expect(rung2Server).toMatch(/^fake:snap_/);
    // open() still answers from last state as a live tree (invisible graduation).
    expect(await runtime.open(created.id, ada)).toMatchObject({ kind: "tree" });
    // The machine is genuinely reachable over real HTTP semantics through the proxy path.
    const fnCall = await runtime.call(created.id, "fn:total", { n: 2 }, ada);
    expect(fnCall).toMatchObject({ status: "ok", output: { name: "total", args: { n: 2 } } });

    // Rung 3 — server-computed tree. Rendering STAYS on the instant path.
    const toComputed = await runtime.edit(created.id, "Return a server-computed dashboard tree", ada);
    expect(toComputed.issues).toBeUndefined();
    expect(toComputed.version.rung).toBe(3);
    const rung3Server = await storedServer(store, created.id);
    expect(rung3Server).toMatch(/^fake:snap_/);
    expect(rung3Server).not.toBe(rung2Server); // re-snapshotted after the edit
    expect(await runtime.open(created.id, ada)).toMatchObject({ kind: "tree" });

    // Every transition was recorded in the capped history, newest first.
    const history = await runtime.history(created.id).list();
    expect(history.map((entry) => entry.rung)).toEqual([3, 2]);
  });

  it("opens rung 4 from last state as a cover screenshot, then the live http surface", async () => {
    const store = memoryStore();
    const sandbox = fakeSandbox();
    const seed = await sandbox.create({ env: {} });
    const server = await seed.snapshot();
    const runtime = createApps({
      store,
      guard: guardFixture(),
      tools,
      sandbox,
      proxyUrl: "https://proxy.test",
      catalog: [],
      model: ladderModel(),
    });
    const ada = ctx();
    const app = await runtime.create({ prompt: "Full app" }, ada);
    await seedAppRow(store, { ...app, ui: "http", server }, ada.principal.subject);
    // The kept cover (06-apps §1: loading cover = a dimmed screenshot) lives in the app blob namespace.
    await store.blobs(`app:${app.id}`).put("cover.png", new Uint8Array([137, 80, 78, 71]), { contentType: "image/png" });

    // First open while the snapshot is waking: a non-interactive resuming cover from last state.
    const resuming = await runtime.open(app.id, ada);
    expect(resuming.kind).toBe("resuming");
    if (resuming.kind !== "resuming") throw new Error("expected resuming");
    expect(resuming.cover).toMatch(/^data:image\/png;base64,/);

    // Once the machine is awake, open() serves the real http surface.
    await vi.waitFor(() => expect(sandbox.machines.size).toBe(2));
    await expect(runtime.open(app.id, ada)).resolves.toEqual({
      kind: "http",
      url: expect.stringContaining("fake-machine"),
    });
  });

  it("keeps the previous rung serving when the next rung fails to build", async () => {
    const serveV1: MachineApp = (request) => request.path === "/fn/version"
      ? { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ result: "v1" }) }
      : { status: 404, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: { code: "x", message: "no" } }) };
    const base = fakeSandbox({ app: serveV1 });
    const seed = await base.create({ env: {} });
    const server = await seed.snapshot();
    // Every resumed machine fails `node --check`, so the escalation's fork edit cannot
    // snapshot — but the already-live serving machine never execs, so it keeps serving v1.
    const failingBuild: SandboxAdapter = {
      create: (spec) => base.create(spec),
      async resume(ref) {
        const machine = await base.resume(ref);
        machine.programExec({ code: 1, stdout: "", stderr: "SyntaxError: unexpected token" });
        return machine;
      },
    };
    const store = memoryStore();
    // A rung-2 app: the instant-path tree AND a live server.
    const app: AppDocument = {
      format: VENDO_APP_FORMAT,
      id: "app_serving",
      name: "Serving",
      ui: "tree",
      tree: {
        formatVersion: "vendo-genui/v1",
        root: "root",
        nodes: [{ id: "root", component: "Text", source: "prewired", props: { text: "Serving" } }],
      },
      server,
    };
    await seedAppRow(store, app, "user_ada");
    const runtime = createApps({
      store,
      guard: guardFixture(),
      tools,
      sandbox: failingBuild,
      catalog: [],
      model: scriptedLanguageModel(JSON.stringify({ rung: 2, files: [{ path: "/app/server.js", content: "broken(" }] })),
    });
    const ada = ctx();

    // The previous rung (v1) is live and serving.
    await expect(runtime.call(app.id, "fn:version", {}, ada)).resolves.toEqual({ status: "ok", output: "v1" });

    // The escalation fails to build — edit surfaces issues and never mutates the document.
    const failed = await runtime.edit(app.id, "Add a server that fails to compile", ada);
    expect(failed.issues?.length).toBeGreaterThan(0);
    expect(await storedServer(store, app.id)).toBe(server); // server ref unchanged

    // The old rung is STILL serving v1 (never swapped to a half-built machine).
    await expect(runtime.call(app.id, "fn:version", {}, ada)).resolves.toEqual({ status: "ok", output: "v1" });
    await expect(runtime.open(app.id, ada)).resolves.not.toMatchObject({ kind: "resuming" });
  });

  it("refuses to graduate a tree app straight to rung 4 in v0 (documented boundary)", async () => {
    const store = memoryStore();
    const sandbox = fakeSandbox();
    const runtime = createApps({ store, guard: guardFixture(), tools, sandbox, catalog: [], model: ladderModel() });
    const ada = ctx();
    const app = await runtime.create({ prompt: "A tree app" }, ada);

    const result = await runtime.edit(app.id, "Turn this into a full web app", ada);

    // ui:"http" is never a prerequisite (06-apps §2): the engine blocks the tree→http jump.
    expect(result.issues?.some((issue) => issue.includes("cannot graduate a tree app to rung 4"))).toBe(true);
    expect((await runtime.get(app.id, ada))?.ui).toBe("tree"); // document untouched
  });
});
