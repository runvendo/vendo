/**
 * The front door's routing seam — blueprint §1 point 2 and §4.5.
 *
 * `vendo_make` starts every request in the screen agent, and the answer it gets
 * back is the answer the person gets. `escalate` is a request for the builder,
 * and what it gets depends on one thing — whether this deployment has a sandbox
 * to build in. Everything else is assembly coming back empty, which is now the
 * end of the ask rather than a quiet hand-off to a second engine. Three
 * properties make that safe rather than merely intended:
 *
 * 1. **One app id, whichever way an escalation lands.** An escalation has already
 *    written `plan.vendo` at the id it was handed and its skeleton is already
 *    painted on `vendoViewStreamId(appId)`. A build that minted its own id would
 *    paint the finished app onto a SECOND stream and leave that skeleton beside it
 *    as a card that builds forever; a failure reported against a different id
 *    would leave the same orphan.
 * 2. **A deployment that cannot build says so.** No sandbox means no machine, so
 *    the receipt fails honestly instead of spending a build's latency on a worse
 *    version of the screen the person was already shown.
 * 3. **An unwired or unserving assembler surfaces LOUDLY.** Composition forgetting
 *    the slot, an assembler that threw, an `unavailable`, and an `assembled` that
 *    left no row are four different bugs and four failed receipts — never a
 *    "ready" served by an engine nobody chose.
 */
import type { AppId, RunContext, ScreenAssembler, ScreenRequest, ToolRegistry, VendoViewPart } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createAgentTools } from "./agent-tools.js";
import { fakeBoxSandbox } from "./testing/fake-box.js";
import { createApps } from "./index.js";
import { basicLanguageModel, guardFixture, memoryStore } from "./testing/index.js";

const ctx: RunContext = {
  principal: { kind: "user", subject: "user_screen" },
  venue: "chat",
  presence: "present",
  sessionId: "session_screen",
};

const tools: ToolRegistry = {
  async descriptors() { return []; },
  async execute() { return { status: "error", error: { code: "not-found", message: "no tools" } }; },
};

/** Every prompt the build was handed, so the escalated plan reaching the build
 *  brief is proved by what the model READ rather than by a comment. */
const briefs: string[] = [];

const runtimeWith = (screen?: ScreenAssembler, options: {
  /** Configure a sandbox — the ONE thing that decides whether an escalation
   *  becomes a build. Its presence is the opt-in; there is no flag. */
  sandbox?: boolean;
  /** §4.5's other half: the plan the escalating agent left behind. */
  escalatedPlan?: string;
} = {}) => {
  briefs.length = 0;
  const model = basicLanguageModel();
  const watched = {
    ...model,
    doStream: async (call: { prompt: unknown }) => {
      briefs.push(JSON.stringify(call.prompt));
      return await (model as unknown as { doStream(c: unknown): Promise<unknown> }).doStream(call);
    },
    doGenerate: async (call: { prompt: unknown }) => {
      briefs.push(JSON.stringify(call.prompt));
      return await (model as unknown as { doGenerate(c: unknown): Promise<unknown> }).doGenerate(call);
    },
  } as typeof model;
  const escalatedPlan = options.escalatedPlan === undefined
    ? undefined
    : async () => options.escalatedPlan;
  const runtime = createApps({
    store: memoryStore(),
    guard: guardFixture(),
    tools,
    catalog: [],
    model: watched,
    ...(options.sandbox === true
      ? { machine: { sandbox: fakeBoxSandbox(), buildEnv: () => ({ PORT: "8080" }), boxEditPollMs: 5 } }
      : {}),
    ...(screen === undefined ? {} : { screen }),
    ...(escalatedPlan === undefined ? {} : { escalatedPlan }),
  });
  return {
    runtime,
    briefs,
    agentTools: createAgentTools(runtime, {
      data: {} as never,
      requireOwned: async () => { throw new Error("unused"); },
      ...(screen === undefined ? {} : { screen }),
      ...(escalatedPlan === undefined ? {} : { escalatedPlan }),
    }),
  };
};

/** An assembler that records what it was handed and answers however the test says. */
function recordingAssembler(answer: Awaited<ReturnType<ScreenAssembler["assemble"]>>) {
  const seen: ScreenRequest[] = [];
  return {
    seen,
    assembler: { assemble: async (request: ScreenRequest) => { seen.push(request); return answer; } },
  };
}

const make = async (
  agentTools: ReturnType<typeof createAgentTools>,
  request = "Show my spending by category",
) => await agentTools.execute({ id: "call_1", tool: "vendo_make", args: { request } }, ctx);

const ESCALATED_PLAN = '<Plan name="Invoice matcher">\n  <Group title="Matches"><Leaf component="Text" purpose="the matches"/></Group>\n</Plan>';

describe("an escalation and the build that finishes it share ONE app id", () => {
  it("the build runs at the id the screen agent was handed, anchored on its plan", async () => {
    const { seen, assembler } = recordingAssembler({ kind: "escalate", why: "this needs real code" });
    const { agentTools, briefs } = runtimeWith(assembler, { sandbox: true, escalatedPlan: ESCALATED_PLAN });

    const outcome = await make(agentTools);

    expect(outcome.status).toBe("ok");
    const receipt = (outcome as { output: { id: string; status: string } }).output;
    // The assembler was consulted first — the seam routes, the caller does not.
    expect(seen).toHaveLength(1);
    // …and the app the build went on to make IS the app whose plan the screen
    // agent wrote. This is the assertion that stops a stranded skeleton.
    expect(receipt.id).toBe(seen[0]?.appId);
    // An escalation with somewhere to build is a BUILD, not a failure.
    expect(receipt.status).toBe("ready");
    // And the plan reached the brain, so the outline the person is watching is
    // what gets built rather than a second, unrelated answer to the same ask.
    expect(briefs.join("\n")).toContain("Invoice matcher");
    // The ask still travels verbatim beside it — the plan is a brief, not a
    // replacement for what the person said.
    expect(briefs.join("\n")).toContain("Show my spending by category");
  });

  it("with no sandbox the escalation FAILS honestly at the same id, and nothing is generated", async () => {
    // An escalation asks for a machine. Answering it with a second pass at
    // assembly would spend a full build's latency to arrive at a worse version of
    // the screen the person already saw.
    const { seen, assembler } = recordingAssembler({ kind: "escalate", why: "this needs real code" });
    const { agentTools, briefs } = runtimeWith(assembler);

    const outcome = await make(agentTools);

    expect(outcome.status).toBe("ok");
    const receipt = (outcome as { output: { id: string; status: string; say: string } }).output;
    expect(receipt.status).toBe("failed");
    // Same id: the failure is ABOUT the app whose skeleton is on screen.
    expect(receipt.id).toBe(seen[0]?.appId);
    // The say names the capability gap in the person's terms, not the flag's.
    expect(receipt.say).toContain("real build");
    // Nothing was generated: not one model call went out.
    expect(briefs).toHaveLength(0);
  });

  it("`create` honours a caller-minted id and paints every view on it", async () => {
    const { runtime } = runtimeWith();
    const appId = "app_caller_minted" as AppId;
    const parts: VendoViewPart[] = [];

    const app = await runtime.create({ appId, prompt: "Show my spending", onView: (part) => parts.push(part) }, ctx);

    expect(app.id).toBe(appId);
    expect(parts.length).toBeGreaterThan(0);
    expect(new Set(parts.map((part) => part.appId))).toEqual(new Set([appId]));
  });
});

/** The four ways assembly comes back with no screen. Each one used to be
 *  absorbed by a second engine; each one is now the answer. */
describe("assembly that produces no screen fails honestly", () => {
  const unbuilt = (outcome: Awaited<ReturnType<typeof make>>) => {
    expect(outcome.status).toBe("ok");
    return (outcome as { output: { id: string; status: string; title: string; say: string } }).output;
  };

  it("an unwired assembler is a composition bug, and it says so", async () => {
    const { agentTools, briefs } = runtimeWith();

    const receipt = unbuilt(await make(agentTools));

    expect(receipt.status).toBe("failed");
    expect(receipt.say).toContain("nothing in this deployment builds screens");
    // The ask, so the sentence and the card are about the same thing.
    expect(receipt.title).toBe("Show my spending by category");
    // Nothing was generated behind the person's back: not one model call.
    expect(briefs).toHaveLength(0);
  });

  it("an `unavailable` hands the assembler's own `why` to the person", async () => {
    const { assembler } = recordingAssembler({ kind: "unavailable", why: "no workspace here" });
    const { agentTools, briefs } = runtimeWith(assembler);

    const receipt = unbuilt(await make(agentTools));

    expect(receipt.status).toBe("failed");
    // Verbatim — a generic apology is nothing the person can act on.
    expect(receipt.say).toContain("no workspace here");
    expect(briefs).toHaveLength(0);
  });

  it("an assembler that THROWS reports the throw, not a rescue", async () => {
    const throwing: ScreenAssembler = { assemble: async () => { throw new Error("assembler exploded"); } };
    const { agentTools, briefs } = runtimeWith(throwing);

    const receipt = unbuilt(await make(agentTools));

    expect(receipt.status).toBe("failed");
    expect(receipt.say).toContain("assembler exploded");
    expect(briefs).toHaveLength(0);
  });

  it("an `assembled` that left no ROW behind is not an app — a picture of one is not one", async () => {
    // The screen agent said it assembled, but nothing renderable ever reached the
    // store, so `authored` upserted no row. The front door checks the row rather
    // than trusting the answer.
    const { assembler } = recordingAssembler({ kind: "assembled" });
    const { agentTools, briefs } = runtimeWith(assembler);

    const receipt = unbuilt(await make(agentTools));

    expect(receipt.status).toBe("failed");
    expect(receipt.say).toContain("wasn't something I could show");
    expect(briefs).toHaveLength(0);
  });
});
