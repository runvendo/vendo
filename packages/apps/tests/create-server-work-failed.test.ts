import { type RunContext, type ToolRegistry } from "@vendoai/core";
import { type ScreenAssembler } from "../src/contract/index.js";
import { describe, expect, it, vi } from "vitest";
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
 * document (the row is real — the app lists, opens and takes an edit), and the
 * failure gets an honest signal — `onServerWork`, an error-level `log()`, and a completion
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
  machine: { sandbox: fakeBoxSandbox({ agent }), buildEnv: () => ({ PORT: "8080" }), boxEditPollMs: 5 },
  servedProxyPath: (appId) => `/api/vendo/apps/${appId}/serve/`,
});

const brokenBox: FakeBoxAgent = () => ({ ok: false, summary: BOX_GAVE_UP, filesChanged: [], testsRun: 0 });

/** The box builds the work and names the function it wrote — the plain success
 *  the failure-only signal has to stay silent for. */
const workingBox: FakeBoxAgent = ({ box }) => {
  box.fns.set("listInvoices", () => ({ invoices: [] }));
  return { ok: true, summary: "wrote the invoice server", filesChanged: ["/app/server.js"], testsRun: 2, fns: ["listInvoices"] };
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

  // REMOVED by the consent slice (S3): `vendo_make` no longer calls `create` on
  // an escalation — it raises the standing build card and returns
  // "awaiting-consent" — so the two receipts this file used to pin through the
  // agent bridge ("partial", and the half-success `say`) have no producer left.
  // The create door's own signals below are untouched.
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

  it("stays silent when the box builds what was asked for (the signal is failure-only)", async () => {
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
