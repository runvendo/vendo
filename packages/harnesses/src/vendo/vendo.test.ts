/**
 * `vendo()` — build-list item 4: today's `@vendoai/agent` loop (the streamText
 * call inside the createUIMessageStream closure) lifted onto `run(turn)`. Same
 * behaviour; tools now through `turn.tools`; output as HarnessEvents; plus
 * subagent hiring.
 *
 * These suites assert the LOOP, not a model: the thinker is scripted so what is
 * measured is the lift.
 */
import { createTurnSkills, renderSkillMd, skillPath } from "@vendoai/core";
import type { HarnessEvent, Json, ToolDescriptor, Turn } from "@vendoai/core";
import { APICallError } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { vendo, type HarnessHand } from "./vendo.js";
import { createTurnState } from "../harness-state.js";
import { createTurnTools } from "../turn-tools.js";
import type { HireRecord } from "../runtime.js";
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
} from "../test-doubles.test-util.js";

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
  /** The per-turn options a caller sent — `Turn.options`, as `runtime.run`
   *  delivers them: typed by `VendoHarnessOptions`, never schema-parsed. */
  options?: Record<string, unknown>;
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
  /** How many times the loop re-read the equipped listing — the discovery rail's
   *  only observable, and what a closed loadout must not do more than once. */
  const listCalls = { count: 0 };
  const workspace = testWorkspace();
  const turn: Turn = {
    messages: options.messages ?? [userMessage("m1", "hello")],
    tools: {
      call: (name, args) => turnTools.call(name, args),
      list: async () => {
        listCalls.count += 1;
        return await turnTools.list();
      },
    },
    skills: options.skills ?? testSkills(),
    workspace,
    models: options.models,
    state: createTurnState(undefined),
    options: options.options ?? {},
    signal: options.signal ?? new AbortController().signal,
    interactive: options.interactive ?? true,
  };
  const events: HarnessEvent[] = [];
  for await (const event of options.harness.run(turn)) events.push(event);
  turnTools.dispose();
  return { events, registry, guard, mirrored, workspace, listCalls };
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
      state: createTurnState(undefined),
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
  /** The brief one scripted call actually carried: the user half of the hire's
   *  one-message thread. Read out rather than matched inside a JSON dump, so an
   *  assertion can quote a notice that contains quotes of its own. */
  const briefOf = (prompt: unknown): string =>
    (prompt as Array<{ role: string; content: Array<{ text?: string }> }>)
      .filter((message) => message.role === "user")
      .flatMap((message) => message.content.map((part) => part.text ?? ""))
      .join("");

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

  it("hiring for a skill that does not exist degrades the hire — the specialist still runs", async () => {
    const model = scriptedModel([
      // The name a model GUESSES when it has no listing to read: the incident
      // behind this case passed `research` where only `building-apps` existed.
      toolCallTurn("hire_subagent", { instructions: "research the market", skill: "research" }),
      textTurn("researched what I could"),
      textTurn("Here's what I found."),
    ]);
    const { events } = await drive({ harness: vendo(), models: seats(model), skills });
    // Three model calls: the specialist was hired, not lost to a wrong string.
    expect(model.calls).toBe(3);
    expect(texts(events)).toBe("Here's what I found.");
    // ...and it was told what it is missing, so it can say what it could not cover.
    const brief = briefOf(model.prompts[1]);
    expect(brief).toContain('The "research" skill could not be loaded');
    expect(brief).toContain("research the market");
  });

  it("loads a real skill in full even when a sibling hire names one that does not exist", async () => {
    /** ONE step, TWO hires — the incident's shape. `toolCallTurn` carries a finish
     *  part of its own, so the first hire's is dropped to splice them into a
     *  single step. Both specialists reply the same words, so which of the two
     *  takes which scripted turn cannot matter. */
    const twoHires = [
      ...toolCallTurn("hire_subagent", { instructions: "research the market", skill: "research" }, "h1")
        .slice(0, -1),
      ...toolCallTurn("hire_subagent", { instructions: "build the app", skill: "building-apps" }, "h2"),
    ];
    const model = scriptedModel([
      twoHires,
      textTurn("specialist done"),
      textTurn("specialist done"),
      textTurn("Both are done."),
    ]);

    const { events } = await drive({ harness: vendo(), models: seats(model), skills });

    expect(texts(events)).toBe("Both are done.");
    // A guessed name degrades ITS OWN hire and nothing else: the mounted skill's
    // body still reached the specialist that asked for it.
    const briefs = [briefOf(model.prompts[1]), briefOf(model.prompts[2])];
    expect(briefs.filter((brief) => brief.includes("Run me in a fresh subagent"))).toHaveLength(1);
    expect(briefs.filter((brief) => brief.includes('The "research" skill could not be loaded')))
      .toHaveLength(1);
  });

  it("hires on a readable skill even when an UNRELATED one on the mount will not read", async () => {
    const model = scriptedModel([
      toolCallTurn("hire_subagent", { instructions: "build it", skill: "building-apps" }),
      textTurn("subagent done"),
      textTurn("Done."),
    ]);
    // The REAL store, over a mount carrying one broken neighbour. The hire opens
    // its OWN skill and nothing else — `list()` would have read every file on the
    // mount, including this one, and taken a perfectly good hire down with it.
    const files: Record<string, string> = {
      [skillPath("building-apps")]: renderSkillMd({
        name: "building-apps",
        description: "how to build an app",
        body: "# Building apps\nRun me in a fresh subagent.",
      }),
      [skillPath("half-written")]: "",
    };
    const brokenMount = createTurnSkills({
      getAllPaths: () => Object.keys(files),
      readFile: async (path) => {
        if (path === skillPath("half-written")) throw new Error("EIO: unreadable SKILL.md");
        return files[path] as string;
      },
    });

    const { events } = await drive({ harness: vendo(), models: seats(model), skills: brokenMount });

    expect(model.calls).toBe(3);
    expect(texts(events)).toBe("Done.");
    // The full body, not the notice: this hire's own skill read fine.
    const brief = briefOf(model.prompts[1]);
    expect(brief).toContain("Run me in a fresh subagent");
    expect(brief).not.toContain("could not be loaded");
  });

  it("hires with the same honest notice when the requested skill itself will not read", async () => {
    const model = scriptedModel([
      toolCallTurn("hire_subagent", { instructions: "build it", skill: "building-apps" }),
      textTurn("did what I could without it"),
      textTurn("Done."),
    ]);
    // The REQUESTED skill is mounted and its own file will not read. Nothing here
    // can tell that from a name nobody mounted — `load()` throws the same plain
    // `Error` for both — so the hire does not pretend to know which, and the one
    // notice covers both truthfully.
    const files: Record<string, string> = { [skillPath("building-apps")]: "" };
    const unreadable = createTurnSkills({
      getAllPaths: () => Object.keys(files),
      readFile: async () => {
        throw new Error("EIO: unreadable SKILL.md");
      },
    });

    const { events } = await drive({ harness: vendo(), models: seats(model), skills: unreadable });

    // Soft, like every other load failure: a running specialist beats a hire
    // nobody made (#899), and the brief says plainly what did not arrive.
    expect(model.calls).toBe(3);
    expect(texts(events)).toBe("Done.");
    expect(briefOf(model.prompts[1])).toContain('The "building-apps" skill could not be loaded');
  });

  it("reports the specialist's tokens as the SPECIALIST's, never folded into the turn's", async () => {
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
    const hires: HireRecord[] = [];
    const { events } = await drive({
      harness: vendo({ onHire: (record) => hires.push(record) }),
      models: seats(model),
      skills,
    });
    const usage = events.find((event) => event.type === "usage") as
      | Extract<HarnessEvent, { type: "usage" }>
      | undefined;
    // The resident loop's own spend. Adding the hire's 90,000 here as well is
    // what over-billed: the hire is ALSO reported below, and the runtime writes
    // each report as its own audit row, so a host summing rows paid twice.
    expect(usage?.inputTokens).toBe(1_000);
    expect(usage?.outputTokens).toBe(100);
    // The hire's spend, once, in full — cache split included, because its row is
    // the only row that carries it. (The rows themselves: ./ledger.test.ts.)
    expect(hires).toHaveLength(1);
    expect(hires[0]!.usage).toMatchObject({ inputTokens: 90_000, outputTokens: 4_000 });
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

describe("vendo() — the closed loadout (`tools`)", () => {
  const hostTools = {
    maple_invoices_list: { descriptor: readTool("maple_invoices_list"), execute: () => ({ count: 2 }) },
    maple_pay: { descriptor: readTool("maple_pay", "destructive"), execute: () => ({ ok: true }) },
  };

  /** A hand the harness itself provides. It reaches THIS run's workspace through
   *  the turn, which is the whole reason `execute` takes one. */
  const saveApp: HarnessHand = {
    name: "save_app",
    description: "Save the document.",
    inputSchema: {
      type: "object",
      properties: { content: { type: "string" } },
      required: ["content"],
      additionalProperties: false,
    },
    execute: async (input, turn) => {
      await turn.workspace.writeFile("/user/apps/app_1/app.vendo", (input as { content: string }).content);
      const result = await turn.workspace.commit({ message: "app.vendo" });
      return { saved: result.status === "ok" } as Json;
    },
  };

  it("equips EXACTLY the list: no unnamed host tool, no hire_subagent", async () => {
    const model = scriptedModel([textTurn("nothing to do")]);
    await drive({
      harness: vendo({ tools: ["maple_invoices_list", saveApp] }),
      tools: hostTools,
      models: seats(model),
    });
    expect(model.toolNamesPerCall[0]).toEqual(["maple_invoices_list", "save_app"]);
  });

  it("a named registry tool still runs through the guard-bound call path", async () => {
    const model = scriptedModel([toolCallTurn("maple_invoices_list", {}), textTurn("You have 2.")]);
    const { registry, mirrored } = await drive({
      harness: vendo({ tools: ["maple_invoices_list"] }),
      tools: hostTools,
      models: seats(model),
    });
    expect(registry.invocations.maple_invoices_list).toBe(1);
    // The guard, the audit row and the transcript mirror are not this file's
    // business — which is only true while the call goes through `turn.tools`.
    expect(mirrored).toEqual(["call", "result"]);
  });

  it("an inline hand acts on THIS run's turn, and is invisible to the registry", async () => {
    const model = scriptedModel([toolCallTurn("save_app", { content: "<App name=\"x\" />" }), textTurn("saved")]);
    const { workspace, registry } = await drive({
      harness: vendo({ tools: [saveApp] }),
      tools: hostTools,
      models: seats(model),
    });
    expect(await workspace.readFile("/user/apps/app_1/app.vendo")).toBe("<App name=\"x\" />");
    expect(workspace.commits).toHaveLength(1);
    // A hand is the harness's own: no listing, no registry execution, nothing for
    // another consumer to discover.
    expect(registry.invocations["save_app"]).toBeUndefined();
  });

  it("names a listing that a legit deployment lacks: the tool is simply not offered", async () => {
    // The list is written once, at boot, against a listing that varies per
    // deployment — so a name the host has not got is an ABSENCE, not a fault. It
    // costs nothing at turn time and the model is never told about a tool it
    // cannot call. (Failing loudly here would take down every host that does not
    // ship the optional tool.)
    const model = scriptedModel([textTurn("ok")]);
    await drive({
      harness: vendo({ tools: ["maple_invoices_list", "no_such_tool"] }),
      tools: hostTools,
      models: seats(model),
    });
    expect(model.toolNamesPerCall[0]).toEqual(["maple_invoices_list"]);
  });

  it("hires only when hiring is on the list", async () => {
    const closed = scriptedModel([textTurn("ok")]);
    await drive({ harness: vendo({ tools: ["maple_invoices_list"] }), tools: hostTools, models: seats(closed) });
    expect(closed.toolNamesPerCall[0]).not.toContain("hire_subagent");

    const named = scriptedModel([textTurn("ok")]);
    await drive({
      harness: vendo({ tools: ["maple_invoices_list", "hire_subagent"] }),
      tools: hostTools,
      models: seats(named),
    });
    expect(named.toolNamesPerCall[0]).toContain("hire_subagent");
  });

  it("has no discovery rail: the listing is read ONCE, never re-read after a call", async () => {
    const model = scriptedModel([
      toolCallTurn("maple_invoices_list", {}, "c1"),
      toolCallTurn("maple_invoices_list", {}, "c2"),
      textTurn("done"),
    ]);
    const { listCalls } = await drive({
      harness: vendo({ tools: ["maple_invoices_list"] }),
      tools: hostTools,
      models: seats(model),
    });
    expect(listCalls.count).toBe(1);
  });

  it("leaves the open loadout exactly as it was when `tools` is unset", async () => {
    const model = scriptedModel([textTurn("ok")]);
    await drive({ harness: vendo(), tools: hostTools, models: seats(model) });
    const offered = model.toolNamesPerCall[0] ?? [];
    expect(offered).toContain("maple_invoices_list");
    expect(offered).toContain("maple_pay");
    expect(offered).toContain("hire_subagent");
  });
});

describe("vendo() passes the WHOLE context to the shipped loop", () => {
  // The bug this pins: this caller used to build `context` only when a `maxSteps`
  // existed and to put only `maxSteps` in it. The loop declared a history window
  // and `createAgent` passed one, so a host who set one got it on one route and
  // silently not on the other — and the default route is this one.
  const OLDEST = "the oldest question";
  const NEWEST = "the newest question";
  const twoTurns = (): Turn["messages"] => [
    userMessage("m1", OLDEST),
    userMessage("m2", NEWEST),
  ];

  it("honours a history window set as a deployment default", async () => {
    const model = scriptedModel([textTurn("ok")]);
    await drive({ harness: vendo({ historyWindow: 1 }), models: seats(model), messages: twoTurns() });
    const sent = JSON.stringify(model.prompts[0]);
    expect(sent).toContain(NEWEST);
    expect(sent).not.toContain(OLDEST);
  });

  it("honours a token budget, and a per-turn option beats the default", async () => {
    const model = scriptedModel([textTurn("ok")]);
    await drive({
      harness: vendo({ contextTokenBudget: 100_000 }),
      models: seats(model),
      messages: twoTurns(),
      options: { contextTokenBudget: 10 },
    });
    const sent = JSON.stringify(model.prompts[0]);
    expect(sent).toContain(NEWEST);
    expect(sent).not.toContain(OLDEST);
  });

  /** A provider failure the SDK is willing to retry — what makes the retry budget
   *  observable at all (the shape `failover.test.ts` uses for the same reason). */
  const overloaded = (): APICallError => new APICallError({
    message: "Overloaded",
    url: "https://api.example.test/v1/messages",
    requestBodyValues: {},
    statusCode: 503,
  });
  const alwaysOverloaded = () => new MockLanguageModelV3({
    doStream: () => Promise.reject(overloaded()),
  });

  it("honours a retry budget from either door — 0 spends nothing", async () => {
    // The bug this pins: `maxRetries` was declared on the loop's `TurnContext`
    // and missing from `CONTEXT_KNOBS`, so neither door reached the loop and both
    // spent DEFAULT_MAX_RETRIES instead — three calls where the host asked for one.
    const fromDeps = alwaysOverloaded();
    await drive({ harness: vendo({ maxRetries: 0 }), models: seats(fromDeps) });
    expect(fromDeps.doStreamCalls).toHaveLength(1);

    const fromTurn = alwaysOverloaded();
    await drive({ harness: vendo(), models: seats(fromTurn), options: { maxRetries: 0 } });
    expect(fromTurn.doStreamCalls).toHaveLength(1);
  });

  it("sends the whole thread when nothing is configured", async () => {
    const model = scriptedModel([textTurn("ok")]);
    await drive({ harness: vendo(), models: seats(model), messages: twoTurns() });
    expect(JSON.stringify(model.prompts[0])).toContain(OLDEST);
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
