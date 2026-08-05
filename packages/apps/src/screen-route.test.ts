/**
 * The front door's routing seam — blueprint §1 point 2 and §4.5.
 *
 * `vendo_make` starts every request in the screen agent and falls through to the
 * conductor on every answer but `assembled`. Two properties make that safe rather
 * than merely intended, and both are asserted here against the REAL conductor:
 *
 * 1. **One app id across both engines.** An escalation has already written
 *    `plan.vendo` at the id it was handed and its skeleton is already painted on
 *    `vendoViewStreamId(appId)`. A conductor that minted its own would paint the
 *    finished app onto a SECOND stream and leave that skeleton beside it as a card
 *    that builds forever.
 * 2. **An unwired or unserving assembler changes nothing.** The conductor path is
 *    not amputated by this seam; it is what the seam falls through to.
 */
import type { AppId, RunContext, ScreenAssembler, ScreenRequest, ToolRegistry, VendoViewPart } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createAgentTools } from "./agent-tools.js";
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

const runtimeWith = (screen?: ScreenAssembler) => {
  const runtime = createApps({
    store: memoryStore(),
    guard: guardFixture(),
    tools,
    catalog: [],
    model: basicLanguageModel(),
    ...(screen === undefined ? {} : { screen }),
  });
  return {
    runtime,
    agentTools: createAgentTools(runtime, {
      data: {} as never,
      requireOwned: async () => { throw new Error("unused"); },
      ...(screen === undefined ? {} : { screen }),
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

describe("an escalation and the build that finishes it share ONE app id", () => {
  it("the conductor builds at the id the screen agent was handed", async () => {
    const { seen, assembler } = recordingAssembler({ kind: "escalate", why: "this needs real code" });
    const { agentTools } = runtimeWith(assembler);

    const outcome = await make(agentTools);

    expect(outcome.status).toBe("ok");
    const receipt = (outcome as { output: { id: string } }).output;
    // The assembler was consulted first — the seam routes, the caller does not.
    expect(seen).toHaveLength(1);
    // …and the app the conductor went on to build IS the app whose plan the screen
    // agent wrote. This is the assertion that stops a stranded skeleton.
    expect(receipt.id).toBe(seen[0]?.appId);
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

describe("the conductor is what the seam falls through to", () => {
  it("an unwired assembler leaves vendo_make exactly as it was", async () => {
    const { agentTools } = runtimeWith();
    const outcome = await make(agentTools);
    expect(outcome.status).toBe("ok");
    expect((outcome as { output: { status: string } }).output.status).toBe("ready");
  });

  it("an assembler that cannot serve is not a failed request", async () => {
    const { assembler } = recordingAssembler({ kind: "unavailable", why: "no workspace here" });
    const { agentTools } = runtimeWith(assembler);
    const outcome = await make(agentTools);
    expect(outcome.status).toBe("ok");
    expect((outcome as { output: { status: string } }).output.status).toBe("ready");
  });

  it("an assembler that THROWS is not a failed request either", async () => {
    const throwing: ScreenAssembler = { assemble: async () => { throw new Error("assembler exploded"); } };
    const { agentTools } = runtimeWith(throwing);
    const outcome = await make(agentTools);
    expect(outcome.status).toBe("ok");
    expect((outcome as { output: { status: string } }).output.status).toBe("ready");
  });

  it("an `assembled` that left no ROW behind falls through — a picture of an app is not an app", async () => {
    // The screen agent said it assembled, but nothing renderable ever reached the
    // store, so `authored` upserted no row. The front door checks the row rather
    // than trusting the answer, and the conductor takes the ask.
    const { assembler } = recordingAssembler({ kind: "assembled" });
    const { agentTools } = runtimeWith(assembler);
    const outcome = await make(agentTools);
    expect(outcome.status).toBe("ok");
    const receipt = (outcome as { output: { status: string; title: string } }).output;
    expect(receipt.status).toBe("ready");
    // The conductor's own document, not an invented title over an absent app.
    expect(receipt.title.length).toBeGreaterThan(0);
  });
});
