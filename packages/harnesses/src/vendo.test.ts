/**
 * `vendo()` — build-list item 4: today's `@vendoai/agent` loop (the streamText
 * call inside the createUIMessageStream closure) lifted onto `run(turn)`. Same
 * behaviour; tools now through `turn.tools`; output as HarnessEvents; plus
 * subagent hiring.
 *
 * These suites assert the LOOP, not a model: the thinker is scripted so what is
 * measured is the lift.
 */
import type { HarnessEvent, ToolDescriptor, Turn } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { vendo } from "./vendo.js";
import { createTurnTools } from "./turn-tools.js";
import {
  boundRegistry,
  ctx,
  readTool,
  scriptedModel,
  seats,
  testGuard,
  testSkills,
  testWorkspace,
  textTurn,
  toolCallTurn,
  userMessage,
  ZERO_USAGE,
  type TestGuard,
} from "./test-doubles.test-util.js";

/** Drive a harness directly — the runtime is proven separately, so here the Turn
 *  is assembled by hand and the events are collected raw. */
async function drive(options: {
  harness: ReturnType<typeof vendo>;
  guard?: TestGuard;
  tools?: Record<string, { descriptor: ToolDescriptor; execute: () => unknown }>;
  models: ReturnType<typeof seats>;
  interactive?: boolean;
  signal?: AbortSignal;
  skills?: ReturnType<typeof testSkills>;
  messages?: Turn["messages"];
}) {
  const guard = options.guard ?? testGuard();
  const registry = boundRegistry(
    (options.tools ?? {}) as Parameters<typeof boundRegistry>[0],
    guard,
  );
  const mirrored: string[] = [];
  const turnTools = createTurnTools({
    registry,
    guard,
    ctx: ctx(),
    interactive: options.interactive ?? true,
    mirror: (event) => mirrored.push(event.kind),
  });
  const turn: Turn = {
    messages: options.messages ?? [userMessage("m1", "hello")],
    tools: turnTools,
    skills: options.skills ?? testSkills(),
    workspace: testWorkspace(),
    models: options.models,
    state: { get: () => undefined, set: () => undefined, clear: () => undefined },
    options: {},
    signal: options.signal ?? new AbortController().signal,
    interactive: options.interactive ?? true,
  };
  const events: HarnessEvent[] = [];
  for await (const event of options.harness.run(turn)) events.push(event);
  turnTools.dispose();
  return { events, registry, guard, mirrored };
}

const texts = (events: HarnessEvent[]): string =>
  events
    .filter((event): event is Extract<HarnessEvent, { type: "text" }> => event.type === "text")
    .map((event) => event.delta)
    .join("");

describe("vendo() is a harness", () => {
  it("is named vendo and needs no sandbox — it is the key-free in-process default", () => {
    const harness = vendo();
    expect(harness.name).toBe("vendo");
    expect(harness.requires?.sandbox).not.toBe(true);
  });

  it("declares its per-turn-overridable knobs", () => {
    expect(vendo().optionsSchema).toBeDefined();
  });
});

describe("vendo() — the loop", () => {
  it("yields the model's text as text events", async () => {
    const model = scriptedModel([textTurn("You have 2 unpaid invoices.")]);
    const { events } = await drive({ harness: vendo(), models: seats(model) });
    expect(texts(events)).toBe("You have 2 unpaid invoices.");
  });

  it("yields usage for metering, never as text", async () => {
    const model = scriptedModel([
      textTurn("done", {
        inputTokens: { total: 1200, noCache: 300, cacheRead: 900, cacheWrite: 0 },
        outputTokens: { total: 40, text: 40, reasoning: 0 },
      }),
    ]);
    const { events } = await drive({ harness: vendo(), models: seats(model) });
    const usage = events.find((event) => event.type === "usage");
    expect(usage).toMatchObject({ type: "usage", inputTokens: 1200, outputTokens: 40 });
    expect(texts(events)).not.toContain("1200");
  });

  it("never yields a view event — §1.6 keeps HarnessEvent closed", async () => {
    const model = scriptedModel([textTurn("hi")]);
    const { events } = await drive({ harness: vendo(), models: seats(model) });
    expect(events.every((event) => ["text", "status", "error", "usage"].includes(event.type))).toBe(true);
  });

  it("reads the `default` seat, and a per-turn model option overrides it", async () => {
    const seat = scriptedModel([textTurn("from the seat")]);
    const override = scriptedModel([textTurn("from the override")]);
    const models = { ...seats(seat), default: seat };
    const turnTools = createTurnTools({
      registry: boundRegistry({}, testGuard()),
      guard: testGuard(),
      ctx: ctx(),
      interactive: true,
      mirror: () => undefined,
    });
    const turn: Turn<{ model?: unknown }> = {
      messages: [userMessage("m1", "hello")],
      tools: turnTools,
      skills: testSkills(),
      workspace: testWorkspace(),
      models,
      state: { get: () => undefined, set: () => undefined, clear: () => undefined },
      options: { model: override },
      signal: new AbortController().signal,
      interactive: true,
    };
    const events: HarnessEvent[] = [];
    for await (const event of vendo().run(turn as Turn)) events.push(event);
    expect(texts(events)).toBe("from the override");
    expect(seat.calls).toBe(0);
  });
});

describe("vendo() — tools go through turn.tools, never a private path", () => {
  const tools = {
    maple_invoices_list: { descriptor: readTool("maple_invoices_list"), execute: () => ({ count: 2 }) },
  };

  it("executes a model tool call through the guard-bound registry", async () => {
    const model = scriptedModel([
      toolCallTurn("maple_invoices_list", { status: "unpaid" }),
      textTurn("You have 2."),
    ]);
    const { events, registry, mirrored } = await drive({
      harness: vendo({ descriptors: async () => [readTool("maple_invoices_list")] }),
      tools,
      models: seats(model),
    });
    expect(registry.invocations.maple_invoices_list).toBe(1);
    expect(texts(events)).toBe("You have 2.");
    // The RUNTIME mirrored it (call + result); the harness yielded neither.
    expect(mirrored).toEqual(["call", "result"]);
  });

  it("offers the model the equipped tools with their real argument schemas", async () => {
    const model = scriptedModel([textTurn("nothing to do")]);
    await drive({
      harness: vendo({ descriptors: async () => [readTool("maple_invoices_list")] }),
      tools,
      models: seats(model),
    });
    expect(model.toolNamesPerCall[0]).toContain("maple_invoices_list");
  });

  it("a denied call is visible to the model as a denial, and the loop continues", async () => {
    const model = scriptedModel([
      toolCallTurn("maple_invoices_list", {}),
      textTurn("I'm not allowed to look at those."),
    ]);
    const { events, registry } = await drive({
      harness: vendo({ descriptors: async () => [readTool("maple_invoices_list")] }),
      guard: testGuard({ maple_invoices_list: "block" }),
      tools,
      models: seats(model),
    });
    expect(registry.invocations.maple_invoices_list).toBeUndefined();
    expect(texts(events)).toBe("I'm not allowed to look at those.");
  });

  it("a tool that errors does not kill the turn", async () => {
    const model = scriptedModel([
      toolCallTurn("boom", {}),
      textTurn("That didn't work — want me to try again?"),
    ]);
    const { events } = await drive({
      harness: vendo({ descriptors: async () => [readTool("boom")] }),
      tools: {
        boom: {
          descriptor: readTool("boom"),
          execute: () => {
            throw new Error("upstream 500");
          },
        },
      },
      models: seats(model),
    });
    expect(texts(events)).toContain("didn't work");
  });
});

describe("vendo() — bounded by construction", () => {
  it("stops at the step cap and says so, rather than looping silently", async () => {
    // Every turn asks for another tool call; only the cap ends it.
    const model = scriptedModel([
      toolCallTurn("maple_invoices_list", {}, "c1"),
      toolCallTurn("maple_invoices_list", {}, "c2"),
      toolCallTurn("maple_invoices_list", {}, "c3"),
    ]);
    const { events } = await drive({
      harness: vendo({ descriptors: async () => [readTool("maple_invoices_list")], maxSteps: 2 }),
      tools: {
        maple_invoices_list: { descriptor: readTool("maple_invoices_list"), execute: () => ({ count: 2 }) },
      },
      models: seats(model),
    });
    expect(model.calls).toBe(2);
    // The user is told the turn ended on the cap, not on the model finishing.
    expect(texts(events).toLowerCase()).toContain("step");
  });

  it("a model failure becomes an honest error event, with no internals", async () => {
    const model = scriptedModel([]);
    const { events } = await drive({ harness: vendo(), models: seats(model) });
    const error = events.find((event) => event.type === "error");
    expect(error).toBeDefined();
    expect(JSON.stringify(events)).not.toContain("scripted model exhausted");
  });

  it("an already-aborted turn makes no model call at all", async () => {
    const controller = new AbortController();
    controller.abort();
    const model = scriptedModel([textTurn("should never run")]);
    const { events } = await drive({
      harness: vendo(),
      models: seats(model),
      signal: controller.signal,
    });
    expect(model.calls).toBe(0);
    expect(events).toEqual([]);
  });
});

describe("vendo() — subagent hiring (build-list item 4)", () => {
  const skills = testSkills([
    {
      name: "building-apps",
      description: "how to build an app",
      body: "# Building apps\nRun me in a fresh subagent.",
    },
  ]);

  it("offers the resident a way to hire its own staff", async () => {
    const model = scriptedModel([textTurn("nothing to do")]);
    await drive({ harness: vendo(), models: seats(model), skills });
    expect(model.toolNamesPerCall[0]).toContain("hire_subagent");
  });

  it("the subagent's own words never reach the screen — one assistant, always", async () => {
    const model = scriptedModel([
      // resident hires
      toolCallTurn("hire_subagent", { instructions: "build the invoices app", skill: "building-apps" }),
      // the subagent's turn
      textTurn("SUBAGENT CHATTER: I am writing the plan file now"),
      // resident's own reply
      textTurn("Your invoices app is ready."),
    ]);
    const { events } = await drive({ harness: vendo(), models: seats(model), skills });
    expect(texts(events)).toBe("Your invoices app is ready.");
    expect(texts(events)).not.toContain("SUBAGENT CHATTER");
  });

  it("loads the named skill so the staff gets the full job description", async () => {
    const model = scriptedModel([
      toolCallTurn("hire_subagent", { instructions: "build it", skill: "building-apps" }),
      textTurn("subagent done"),
      textTurn("Done."),
    ]);
    const { events } = await drive({ harness: vendo(), models: seats(model), skills });
    expect(texts(events)).toBe("Done.");
    // The skill body reached the subagent's prompt, not the user's screen.
    expect(JSON.stringify(events)).not.toContain("Run me in a fresh subagent");
  });

  it("a subagent's tool calls still pass the same guard", async () => {
    const model = scriptedModel([
      toolCallTurn("hire_subagent", { instructions: "look it up" }),
      toolCallTurn("maple_invoices_list", {}, "sub_1"),
      textTurn("subagent found 2"),
      textTurn("You have 2."),
    ]);
    const { registry, mirrored } = await drive({
      harness: vendo({ descriptors: async () => [readTool("maple_invoices_list")] }),
      tools: {
        maple_invoices_list: { descriptor: readTool("maple_invoices_list"), execute: () => ({ count: 2 }) },
      },
      models: seats(model),
      skills,
    });
    expect(registry.invocations.maple_invoices_list).toBe(1);
    // Authority is always tools, every harness: the subagent's call is mirrored
    // exactly like the resident's.
    expect(mirrored).toContain("call");
    expect(mirrored).toContain("result");
  });

  it("hiring a subagent for an unknown skill fails the tool, not the turn", async () => {
    const model = scriptedModel([
      toolCallTurn("hire_subagent", { instructions: "go", skill: "no-such-skill" }),
      textTurn("I couldn't find the instructions for that."),
    ]);
    const { events } = await drive({ harness: vendo(), models: seats(model), skills });
    expect(texts(events)).toContain("couldn't find");
  });

  it("counts the specialist's tokens into the turn's usage (billing, not the story layer)", async () => {
    const model = scriptedModel([
      toolCallTurn("hire_subagent", { instructions: "big job" }),
      // The specialist's own turn spends the bulk of the tokens.
      textTurn("did the big job", {
        inputTokens: { total: 90_000, noCache: 90_000, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 4_000, text: 4_000, reasoning: 0 },
      }),
      textTurn("All done.", {
        inputTokens: { total: 1_000, noCache: 1_000, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 100, text: 100, reasoning: 0 },
      }),
    ]);
    const hires: Array<{ usage: { inputTokens: number; outputTokens: number } }> = [];
    const { events } = await drive({
      harness: vendo({ onHire: (record) => hires.push(record) }),
      models: seats(model),
      skills,
    });
    const usage = events.find((event) => event.type === "usage") as
      | Extract<HarnessEvent, { type: "usage" }>
      | undefined;
    // The resident alone would report 1,000/100 — 91% of the spend unmetered.
    expect(usage?.inputTokens).toBe(91_000);
    expect(usage?.outputTokens).toBe(4_100);
    // And the hire itself is reported, so composition can audit that it happened.
    expect(hires).toHaveLength(1);
    expect(hires[0]!.usage).toEqual({ inputTokens: 90_000, outputTokens: 4_000 });
  });

  it("a subagent cannot hire a subagent — depth is bounded", async () => {
    const model = scriptedModel([
      toolCallTurn("hire_subagent", { instructions: "outer" }),
      textTurn("inner done"),
      textTurn("all done"),
    ]);
    await drive({ harness: vendo(), models: seats(model), skills });
    // Turn 1 = resident (has the hiring tool), turn 2 = subagent (must not).
    expect(model.toolNamesPerCall[0]).toContain("hire_subagent");
    expect(model.toolNamesPerCall[1]).not.toContain("hire_subagent");
  });
});

describe("vendo() — the system prompt arrives pre-assembled", () => {
  it("takes it by factory closure, because a Turn carries no RunContext", async () => {
    const model = scriptedModel([textTurn("ok")]);
    await drive({
      harness: vendo({ system: () => "You are Maple's assistant." }),
      models: seats(model),
    });
    // Nothing to assert beyond it being accepted and the turn running: the
    // prompt's CONTENT is @vendoai/agent's assembleSystemPrompt, tested there.
    expect(model.calls).toBe(1);
  });
});
