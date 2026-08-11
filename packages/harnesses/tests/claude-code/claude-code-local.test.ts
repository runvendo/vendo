/**
 * THE LOCAL LEG's door diagnostics — the half `claude-code.test.ts` cannot reach.
 *
 * That file drives the REAL box door over a fake transport, on purpose. The
 * local leg has no equivalent: `localMachine()` opens a live Claude Agent SDK
 * session, and the SDK is installed in this repo, so draining a
 * `machine: "local"` turn would spawn the real CLI. So this file — and only this
 * file — doubles `./local.js`. What is under test is `index.ts`'s branch, not
 * where the workspace lands, and the double implements the same `SessionMachine`
 * port the real one does.
 *
 * The behaviour pinned here is a REGRESSION guard. door-internal deleted the
 * old "claudeCode() has no MCP door" operator error because composition now
 * always mounts one — correct — but the surviving diagnostic only fired for a
 * BOX. A production deployment with no `VENDO_BASE_URL` running
 * `claudeCode({ machine: "local" })` therefore ran with none of the product's
 * actions and said NOTHING to anyone.
 */
import type { HarnessEvent, Turn } from "@vendoai/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { SessionMachine, SessionMessage } from "../../src/claude-code/machine.js";
import { emptyTree } from "../../src/materialize.js";
import { createTurnState } from "../../src/harness-state.js";
import { provideHarnessAdapters } from "../../src/harness-sandbox.js";
import { testAppsHooks, testWorkspace, unusedModels, userMessage } from "../../src/test-doubles.test-util.js";

/** Every message the doubled local machine was sent, in order. */
const sent: SessionMessage[] = [];

vi.mock("../../src/claude-code/local.js", () => ({
  localMachine: async (): Promise<SessionMachine> => ({
    carriesSession: false,
    pluginPath: "/tmp/vendo-local-double/host",
    tree: emptyTree(),
    // ⚠️ TEST EDIT — the widened `SessionMachine` requires it. Same loopback
    // answer the real local machine gives.
    async url(port: number) { return `http://127.0.0.1:${port}`; },
    // ⚠️ TEST EDIT — the widened `SessionMachine` requires it. Nothing is ever in
    // flight here (this turn registers no `onSteer`), which is exactly the case
    // the real session answers `false` for.
    async steer() { return false; },
    async materialize() {},
    async collect() { return []; },
    async send(message: SessionMessage) { sent.push(message); },
    async release() {},
  }),
}));

// Imported AFTER the mock declaration; `vi.mock` is hoisted, so `index.ts` binds
// the double.
const { claudeCode } = await import("../../src/claude-code/index.js");

let threadSeq = 0;

function localTurn(): Turn<never> {
  return {
    threadId: `thr_local_${(threadSeq += 1)}`,
    messages: [userMessage(`m_${threadSeq}`, "what do I owe?")],
    tools: { list: async () => [], call: async () => ({ status: "ok" as const, output: { ok: true } }) },
    skills: { list: async () => [], load: async () => "" },
    workspace: testWorkspace({}),
    models: unusedModels(),
    state: createTurnState(undefined),
    options: {} as never,
    signal: new AbortController().signal,
    interactive: true,
    system: "PRODUCT BRIEF",
  } as unknown as Turn<never>;
}

const drain = async (harness: ReturnType<typeof claudeCode>, turn: Turn<never>): Promise<HarnessEvent[]> => {
  const events: HarnessEvent[] = [];
  for await (const event of harness.run(turn as never)) events.push(event);
  return events;
};

let errors: string[];

beforeEach(() => {
  sent.length = 0;
  errors = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const doorWarnings = (): string[] => errors.filter((line) => line.includes("[vendo] claudeCode()"));

/**
 * ORDER MATTERS in this block. The warning is once per PROCESS, so the silent
 * case has to be measured before anything has tripped the flag.
 */
describe("machine: \"local\" and the MCP door's origin", () => {
  test("a REACHABLE door is handed over, and nothing is said", async () => {
    const harness = claudeCode({ machine: "local", ...testAppsHooks() });
    provideHarnessAdapters(harness, {
      toolDoor: { url: "http://127.0.0.1:3000/api/vendo/mcp", mint: () => "vtk_ok", revoke: () => undefined },
    });

    await drain(harness, localTurn());

    expect(sent[0]?.toolDoor).toEqual({ url: "http://127.0.0.1:3000/api/vendo/mcp", token: "vtk_ok" });
    expect(doorWarnings()).toEqual([]);
  });

  test("NO origin: the operator is warned ONCE, naming the fix, and the turn still runs", async () => {
    const harness = claudeCode({ machine: "local", ...testAppsHooks() });
    provideHarnessAdapters(harness, {
      toolDoor: { url: undefined, mint: () => "vtk_x", revoke: () => undefined },
    });

    const events = await drain(harness, localTurn());

    // Loud for the operator, and it names the thing only they can set.
    expect(doorWarnings()).toHaveLength(1);
    expect(doorWarnings()[0]).toContain("VENDO_BASE_URL");
    expect(doorWarnings()[0]).toMatch(/none of your product's actions/i);

    // NOT a refusal — that is the BOX's answer, and it stays the box's. A local
    // thinker with no origin is a workspace-only assistant (see PARKED.md).
    expect(events).not.toContainEqual({
      type: "error",
      message: "I can't use this product's actions right now.",
    });
    // The turn really ran, and really carried no door.
    expect(sent).toHaveLength(1);
    expect(sent[0]?.toolDoor).toBeUndefined();

    // A second turn on the same deployment says it again to nobody.
    await drain(harness, localTurn());
    expect(doorWarnings()).toHaveLength(1);
    expect(sent).toHaveLength(2);
  });
});
