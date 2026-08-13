import { type RunContext, type ToolRegistry } from "@vendoai/core";
import { type ScreenAssembler } from "../src/contract/index.js";
import { describe, expect, it, vi } from "vitest";
import { createAgentTools } from "../src/server/doors/agent-tools.js";
import { createApps } from "../src/server/index.js";
import { fakeBoxSandbox, type FakeBoxAgent } from "../src/server/testing/fake-box.js";
import { guardFixture } from "../src/server/testing/guard-fixture.js";
import { memoryStore } from "../src/server/testing/memory-store.js";
import { basicLanguageModel } from "../src/server/testing/scripted-model.js";

/**
 * The create door used to swallow the whole server lane. `edit` read
 * `served.failed` and refused the edit; `create` read nothing at all and its
 * catch only `console.warn`ed, so a build whose server side never landed
 * painted its skeleton and logged "gen create complete" — an empty app declared
 * successful on a live deployment (2026-08-11).
 *
 * The contract now, mirroring `onUnsaved`: the create STILL resolves with the
 * document (the screen is real and on the person's page), and the failure gets
 * an honest signal — `onServerWork`, an error-level `log()`, and a completion
 * line that says the server work failed.
 *
 * The spies below follow the default log sink, not the level name: `log()` at
 * `info` writes through `console.log` and at `error` through `console.error`
 * (core's `METHODS` table), so this reads exactly the console an operator sees.
 */

const ctx: RunContext = {
  principal: { kind: "user", subject: "user_ada" },
  venue: "chat",
  presence: "present",
  sessionId: "session_ada",
};

const tools: ToolRegistry = {
  async descriptors() { return []; },
  async execute() { return { status: "error", error: { code: "not-found", message: "no tools" } }; },
};

/** A plan that REQUIRES a served surface — the one shape whose server work the
 *  app cannot stand without, which is what `runServerWork` reports as `failed`. */
const SERVED_PLAN = `<Plan name="Invoice board">
  <Group tab="Board"><Leaf component="Text" purpose="the board"/></Group>
  <Server kind="box" served why="Dragging cards between columns is an interaction no component can express."/>
</Plan>`;

const escalating: ScreenAssembler = {
  assemble: async () => ({ kind: "escalate", why: "this needs real code, not an arrangement of components" }),
};

const BOX_GAVE_UP = "could not build the drag-and-drop server";

const setup = (agent: FakeBoxAgent) => createApps({
  store: memoryStore(),
  guard: guardFixture(),
  tools,
  catalog: [],
  model: basicLanguageModel(),
  screen: escalating,
  escalatedPlan: async () => SERVED_PLAN,
  machine: { sandbox: fakeBoxSandbox({ agent }), buildEnv: () => ({ PORT: "8080" }), boxEditPollMs: 5 },
  servedProxyPath: (appId) => `/api/vendo/apps/${appId}/serve/`,
});

const brokenBox: FakeBoxAgent = () => ({ ok: false, summary: BOX_GAVE_UP, filesChanged: [], testsRun: 0 });

/** The box builds fine and CLAIMS it serves the app's whole surface, but never
 *  installs a root page — so the host's own `GET /` check fails, the 2→3 flip is
 *  refused, and the person is left on the skeleton. `runServerWork` reports that
 *  as `issues`, not `failed`, because the box's work itself did land. */
const unservedBox: FakeBoxAgent = () =>
  ({ ok: true, summary: "wrote the drag-and-drop server", filesChanged: ["/app/server.js"], testsRun: 1, servesUi: true });

/** The real front door (`vendo_make`) over the real create door, with nothing
 *  stubbed between them — the seam a receipt's `status` is actually read at. */
const bridge = (agent: FakeBoxAgent) => createAgentTools(setup(agent), {
  data: {} as never,
  requireOwned: async () => { throw new Error("unused"); },
  claimSlot: async () => { throw new Error("unused"); },
  markUnbuilt: async () => { throw new Error("unused"); },
  screen: escalating,
  escalatedPlan: async () => SERVED_PLAN,
});

const workingBox: FakeBoxAgent = ({ box }) => {
  box.pages.set("/", "<!doctype html><title>Invoice kanban</title><h1>Kanban</h1>");
  box.manifest = {};
  return { ok: true, summary: "serving the kanban web app", filesChanged: ["/app/server.js"], testsRun: 2, servesUi: true };
};

describe("a create whose server work could not be built", () => {
  it("tells the caller, logs it, and does not report complete — while still resolving with the app", async () => {
    const runtime = setup(brokenBox);
    // The failure rides the CreateServerWork envelope's `failed` half (#881
    // unified the failure-only signal into the envelope the success path
    // publishes).
    const failures: Array<{ failed?: string[] }> = [];
    const errors: string[] = [];
    const infos: string[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      errors.push(String(line));
    });
    const infoSpy = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      infos.push(String(line));
    });
    try {
      const app = await runtime.create({
        prompt: "Make me a full kanban board for my invoices with drag-and-drop between columns",
        onServerWork: (result) => failures.push(result),
      }, ctx);

      // The app is real and on screen, so the turn still hands it back.
      expect(app.id).toMatch(/^app_/);

      // The signal the door was missing, exactly once, carrying the box's own
      // words rather than a generic apology.
      expect(failures).toHaveLength(1);
      expect(failures[0]?.failed?.join(" ")).toContain(BOX_GAVE_UP);

      // Server-side it is an error, not a shrug.
      expect(errors.some((line) => line.includes("server work failed") && line.includes(app.id))).toBe(true);

      // And the completion line no longer claims a clean build. This is the
      // assertion the original bug failed: it logged "gen create complete".
      const completion = infos.filter((line) => line.includes("gen create complete"));
      expect(completion).toHaveLength(1);
      expect(completion[0]).toContain("gen create complete (server work failed)");
    } finally {
      errorSpy.mockRestore();
      infoSpy.mockRestore();
    }
  });

  it("reads to the person as an honest half-success through the agent bridge, not a plain 'it's on your screen'", async () => {
    // The SEAM: the real front door (`vendo_make`) over the real create door,
    // with nothing stubbed between them. This is what the person actually
    // hears, and an unqualified "on your screen" here is the whole bug —
    // the app is empty and the turn calls it done.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const infoSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const agentTools = bridge(brokenBox);

      const outcome = await agentTools.execute({
        id: "call_1",
        tool: "vendo_make",
        args: { request: "Make me a full kanban board for my invoices with drag-and-drop between columns" },
      }, ctx);

      expect(outcome.status).toBe("ok");
      const output = (outcome as { output: Record<string, unknown> }).output;
      expect(output.say).toBe(
        "I built the screen, but the server-side part didn't get built: "
        + "the in-box agent could not build the server work: could not build the drag-and-drop server"
        + " — the machine was discarded, the rest of the app stands, and the sections that waited on it"
        + " have nothing to show."
        + ". The app works for viewing — ask me to try the build again.",
      );
      // Contract §3.1 — four fields of words, and no document among them.
      expect(Object.keys(output).sort()).toEqual(["id", "say", "status", "title"]);
    } finally {
      errorSpy.mockRestore();
      infoSpy.mockRestore();
    }
  });

  it("says so in `status`, not only in `say` — a host branching on the field must not read plain success", async () => {
    // The bug one field over (found 2026-08-11, the cold walk after the `say`
    // fix above shipped): the sentence told the truth and `status` still said
    // `"ready"`, so everything that BRANCHES rather than reads — a host's own
    // if, the pack's ref capture, an outside agent over MCP — saw a clean build
    // of a half-built app. Not `"failed"` either: the screen is real and
    // reopenable, and `"failed"` means nothing was painted.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const infoSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const broken = (await bridge(brokenBox).execute({
        id: "call_broken",
        tool: "vendo_make",
        args: { request: "Make me a full kanban board for my invoices with drag-and-drop between columns" },
      }, ctx) as { output: Record<string, unknown> }).output;
      expect(broken.status).toBe("partial");

      // The control, through the SAME door: a box that builds what the plan
      // asked for is still plainly `"ready"`. Without this, a `status` hardwired
      // to `"partial"` would pass the assertion above.
      const built = (await bridge(workingBox).execute({
        id: "call_built",
        tool: "vendo_make",
        args: { request: "Make me a full kanban board for my invoices with drag-and-drop between columns" },
      }, ctx) as { output: Record<string, unknown> }).output;
      expect(built.status).toBe("ready");
    } finally {
      errorSpy.mockRestore();
      infoSpy.mockRestore();
    }
  });

  it("reports a served plan whose surface flip was refused — the other half of the same silence", async () => {
    // `failed` is not the only way a served plan comes back half-built: the box
    // can succeed and still fail the host's own `GET /` verification, which
    // `runServerWork` returns as `issues`. `edit` hands those to its caller; a
    // create returns a document, so without this they went nowhere and the app
    // reported complete on a skeleton — the same bug, one branch over.
    const runtime = setup(unservedBox);
    const failures: Array<{ failed?: string[] }> = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const infos: string[] = [];
    const infoSpy = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      infos.push(String(line));
    });
    try {
      const app = await runtime.create({
        prompt: "Make me a full kanban board for my invoices with drag-and-drop between columns",
        onServerWork: (result) => failures.push(result),
      }, ctx);

      // The tree was never replaced, because the flip was refused.
      expect(app.ui).toBe("tree");
      expect(failures).toHaveLength(1);
      expect(failures[0]?.failed?.join(" ")).toContain("did not produce a verified served web app");
      const completion = infos.filter((line) => line.includes("gen create complete"));
      expect(completion[0]).toContain("gen create complete (server work failed)");
    } finally {
      errorSpy.mockRestore();
      infoSpy.mockRestore();
    }
  });

  it("reports the failure exactly once, even when the consumer's own callback throws", async () => {
    // The report used to run INSIDE the try that wraps the server lane, so a
    // throwing consumer re-entered that catch as a second "server work failed":
    // the callback fired twice and the second throw escaped. The host's
    // exception is still the host's — it propagates, once — but it is never
    // relabelled as another server-work failure.
    const runtime = setup(brokenBox);
    const seen: Array<{ failed?: string[] }> = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const infoSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await expect(runtime.create({
        prompt: "Make me a full kanban board for my invoices with drag-and-drop between columns",
        onServerWork: (result) => {
          seen.push(result);
          throw new Error("the host's own listener blew up");
        },
      }, ctx)).rejects.toThrow("the host's own listener blew up");
      expect(seen).toHaveLength(1);
      expect(seen[0]?.failed?.join(" ")).toContain(BOX_GAVE_UP);
    } finally {
      errorSpy.mockRestore();
      infoSpy.mockRestore();
    }
  });

  it("stays silent when the box builds what the plan asked for (the signal is failure-only)", async () => {
    const runtime = setup(workingBox);
    const failures: Array<{ failed?: string[] }> = [];
    const infos: string[] = [];
    const infoSpy = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      infos.push(String(line));
    });
    try {
      const app = await runtime.create({
        prompt: "Make me a full kanban board for my invoices with drag-and-drop between columns",
        onServerWork: (result) => failures.push(result),
      }, ctx);

      expect(failures).toEqual([]);
      const completion = infos.filter((line) => line.includes("gen create complete"));
      expect(completion).toHaveLength(1);
      expect(completion[0]).toContain(`gen create complete app=${app.id}`);
    } finally {
      infoSpy.mockRestore();
    }
  });
});
