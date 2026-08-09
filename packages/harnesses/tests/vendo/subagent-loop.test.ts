/**
 * A hire rides the ONE loop.
 *
 * `runSubagent` used to open a second, bare `streamText` of its own, so every
 * rail `startTurn` owns — the stop conditions, the history assembly, the cache
 * breakpoints, the stated retry budget — stopped at the resident, and a hired
 * specialist ran without them. `vendo()`'s own docstring already claims the
 * opposite ("NOT a second loop"), and the hire was the one caller that made it
 * untrue.
 *
 * What this suite pins: a hire goes through `startTurn` (asserted by rails only
 * that loop has), it still cannot hire — both depth-1 locks — two hires still
 * run at the same time (full parallelism, writes included), and the ledger still
 * partitions the turn into a resident run row plus one audit row per hire.
 */
import {
  ASK_USER_TOOL,
  type HarnessEvent,
  type Json,
  type ToolOutcome,
  type ToolRegistry,
  type Turn,
} from "@vendoai/core";
import type { LanguageModel } from "ai";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { describe, expect, it } from "vitest";
import { vendo, type VendoHarnessOptions } from "../../src/vendo/vendo.js";
import { createTurnTools } from "../../src/turn-tools.js";
import type { HireRecord } from "../../src/runtime.js";
import {
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
  type StreamPart,
} from "../../src/test-doubles.test-util.js";

const HIRE_SUBAGENT = "hire_subagent";

/** The first words of the specialist system prompt. Matching on them is how a
 *  double tells a hire's model call from the resident's, and it pins the prose
 *  as a fixed point at the same time. */
const SPECIALIST_OPENING = "You are a specialist hired for one job.";

/** No host tools at all — the shape most of the hiring cases need. */
const NO_TOOLS: ToolRegistry = {
  descriptors: async () => [],
  execute: async () => ({ status: "error", error: { code: "not-found", message: "no tools" } }),
};

/** Drive the harness directly: the runtime is proven separately, so the Turn is
 *  assembled by hand and the events are collected raw. */
async function driveTurn(options: {
  harness: ReturnType<typeof vendo>;
  registry: ToolRegistry;
  model: LanguageModel;
}): Promise<HarnessEvent[]> {
  const turnTools = createTurnTools({
    registry: options.registry,
    guard: testGuard(),
    ctx: ctx(),
    interactive: true,
    mirror: () => {},
  });
  const turn: Turn<VendoHarnessOptions> = {
    threadId: "thr_subagent",
    turnId: "trn_subagent",
    messages: [userMessage("m1", "get the big job done")],
    tools: turnTools,
    skills: testSkills(),
    workspace: testWorkspace(),
    models: seats(options.model),
    state: { get: () => undefined, set: () => undefined, clear: () => undefined },
    options: {},
    signal: new AbortController().signal,
    interactive: true,
  };
  const events: HarnessEvent[] = [];
  for await (const event of options.harness.run(turn)) events.push(event);
  turnTools.dispose();
  return events;
}

const texts = (events: HarnessEvent[]): string =>
  events
    .filter((event): event is Extract<HarnessEvent, { type: "text" }> => event.type === "text")
    .map((event) => event.delta)
    .join("");

describe("a hire rides `startTurn`, not a second `streamText`", () => {
  it("ends the specialist's turn on an answered ask_user — a stop condition only the loop has", async () => {
    const registry: ToolRegistry = {
      descriptors: async () => [readTool(ASK_USER_TOOL)],
      // Hand-rolled rather than `boundRegistry`: the double wraps whatever it
      // returns in `{status:"ok"}`, which is exactly the field the stop reads.
      execute: async (): Promise<ToolOutcome> => ({
        status: "ok",
        output: { question: "Which account?" } as Json,
      }),
    };
    const model = scriptedModel([
      // 1. the resident hires
      toolCallTurn(HIRE_SUBAGENT, { instructions: "move the money" }),
      // 2. the specialist asks the user a question, and is answered
      toolCallTurn(ASK_USER_TOOL, { question: "Which account?" }),
      // 3. the resident's own reply — reached only if the specialist STOPPED
      textTurn("Done."),
    ]);

    const events = await driveTurn({ harness: vendo(), registry, model });

    // Three model calls, not four. `askedUserStop` ends the specialist's turn the
    // same way it ends the resident's; a bare `streamText` carried only the step
    // cap, so the specialist took another step and ate the resident's script.
    expect(model.calls).toBe(3);
    expect(texts(events)).toBe("Done.");
  });

  it("assembles the specialist's prompt through the loop's own history builder", async () => {
    const model = scriptedModel([
      toolCallTurn(HIRE_SUBAGENT, { instructions: "summarise the ledger" }),
      textTurn("summarised"),
      textTurn("All done."),
    ]);

    await driveTurn({ harness: vendo(), registry: NO_TOOLS, model });

    const hirePrompt = model.prompts[1] as Array<{ role: string; providerOptions?: unknown }>;
    const system = hirePrompt[0];
    expect(system?.role).toBe("system");
    // `turnModelMessages` marks the system block for Anthropic prompt caching
    // (`loop.ts`'s `CACHE_BREAKPOINT`). A raw `streamText({ system })` cannot —
    // the string has nowhere to carry provider options.
    expect(system?.providerOptions).toEqual({ anthropic: { cacheControl: { type: "ephemeral" } } });
    // The brief still arrives, now as the one user message of a one-message thread.
    expect(JSON.stringify(hirePrompt)).toContain("summarise the ledger");
  });

  it("keeps the specialist's own words off the screen and its prose unchanged", async () => {
    const model = scriptedModel([
      toolCallTurn(HIRE_SUBAGENT, { instructions: "do the thing" }),
      textTurn("SPECIALIST CHATTER: here is my inner monologue"),
      textTurn("It's finished."),
    ]);

    const events = await driveTurn({ harness: vendo(), registry: NO_TOOLS, model });

    expect(texts(events)).toBe("It's finished.");
    expect(texts(events)).not.toContain("SPECIALIST CHATTER");
    expect(model.systemPrompts[1]).toBe(
      "You are a specialist hired for one job. Do it with the tools you have, then report back in "
      + "at most three sentences. Your reply is read by another agent, not by a person.",
    );
  });
});

describe("depth stays bounded at one, by both locks", () => {
  it("hands the specialist every tool but the hiring one — tools object and loadout", async () => {
    const registry: ToolRegistry = {
      descriptors: async () => [readTool("maple_invoices_list")],
      execute: async (): Promise<ToolOutcome> => ({ status: "ok", output: { count: 2 } as Json }),
    };
    const model = scriptedModel([
      toolCallTurn(HIRE_SUBAGENT, { instructions: "count the invoices" }),
      textTurn("there are two"),
      textTurn("You have 2."),
    ]);

    await driveTurn({ harness: vendo(), registry, model });

    // The resident's loadout carries the hiring tool.
    expect(model.toolNamesPerCall[0]).toContain(HIRE_SUBAGENT);
    // The specialist's carries neither the tool nor the name. What reached the
    // provider is the tools object AFTER `activeTools` filtered it, so this one
    // reading pins both locks: lock #1 strips `hire_subagent` from the object,
    // lock #2 keeps it out of the loadout the model may pick from.
    expect(model.toolNamesPerCall[1]).toEqual(["maple_invoices_list"]);
  });
});

const HIRE_USAGE = {
  inputTokens: { total: 45_000, noCache: 45_000, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 2_000, text: 2_000, reasoning: 0 },
};
const RESIDENT_USAGE = {
  inputTokens: { total: 900, noCache: 900, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 80, text: 80, reasoning: 0 },
};

/**
 * A model whose SPECIALIST calls block until BOTH of them are running. If the
 * two hires were serialized the first would wait here forever and the test's own
 * timeout — the hang detector — would report it; there is no inner clock.
 */
function overlappingHires(): { model: LanguageModel; order: string[] } {
  const order: string[] = [];
  let started = 0;
  let bothIn: () => void = () => {};
  const bothStarted = new Promise<void>((resolve) => {
    bothIn = resolve;
  });
  const resident: StreamPart[][] = [
    // ONE step, TWO hires. D5: full parallelism, writes included.
    [
      {
        type: "tool-call",
        toolCallId: "h1",
        toolName: HIRE_SUBAGENT,
        input: JSON.stringify({ instructions: "job one" }),
      },
      {
        type: "tool-call",
        toolCallId: "h2",
        toolName: HIRE_SUBAGENT,
        input: JSON.stringify({ instructions: "job two" }),
      },
      { type: "finish", usage: ZERO_USAGE, finishReason: { unified: "tool-calls", raw: undefined } },
    ],
    textTurn("Both specialists are done.", RESIDENT_USAGE),
  ];
  const model = new MockLanguageModelV3({
    doStream: async (request) => {
      const system = request.prompt.find((message) => message.role === "system");
      const brief = typeof system?.content === "string" ? system.content : "";
      if (brief.startsWith(SPECIALIST_OPENING)) {
        const job = JSON.stringify(request.prompt).includes("job one") ? "one" : "two";
        order.push(`start:${job}`);
        started += 1;
        if (started === 2) bothIn();
        await bothStarted;
        order.push(`end:${job}`);
        return { stream: simulateReadableStream({ chunks: textTurn(`${job} done`, HIRE_USAGE) }) };
      }
      const chunks = resident.shift();
      if (chunks === undefined) throw new Error("resident script exhausted");
      return { stream: simulateReadableStream({ chunks }) };
    },
  }) as unknown as LanguageModel;
  return { model, order };
}

describe("two hires in one step, and one ledger between them", () => {
  it("runs both specialists at the same time and partitions the turn's tokens", async () => {
    const { model, order } = overlappingHires();
    const hires: HireRecord[] = [];

    const events = await driveTurn({
      harness: vendo({ onHire: (record) => hires.push(record) }),
      registry: NO_TOOLS,
      model,
    });

    // Both started before either finished — overlap in time, not two turns in a
    // row. Write-lane serialization was explicitly rejected.
    expect(order).toHaveLength(4);
    expect(order.slice(0, 2).map((entry) => entry.split(":")[0])).toEqual(["start", "start"]);
    expect(texts(events)).toBe("Both specialists are done.");

    // The run row is the RESIDENT's spend and only it: 900/80, not 90,900/4,080.
    const usage = events.find((event) => event.type === "usage") as
      | Extract<HarnessEvent, { type: "usage" }>
      | undefined;
    expect(usage).toMatchObject({ inputTokens: 900, outputTokens: 80 });

    // ...and each hire is its own audit row, in full. Summing the rows prices the
    // turn exactly once.
    expect(hires).toHaveLength(2);
    expect(hires.map((record) => record.usage!.inputTokens)).toEqual([45_000, 45_000]);
    expect(hires.map((record) => record.usage!.outputTokens)).toEqual([2_000, 2_000]);
    expect(hires.map((record) => record.purpose).sort()).toEqual(["job one", "job two"]);
  });

  it("hands back the finished work even when the receipt cannot be booked", async () => {
    const model = scriptedModel([
      toolCallTurn(HIRE_SUBAGENT, { instructions: "the big job" }),
      textTurn("the big job is done"),
      textTurn("All set."),
    ]);

    const events = await driveTurn({
      // `onHire` is a public knob a host overrides to observe hires somewhere of
      // its own, so its failures are the host's, not the specialist's.
      harness: vendo({
        onHire: () => {
          throw new Error("receipt sink is down");
        },
      }),
      registry: NO_TOOLS,
      model,
    });

    // The specialist ran and its tokens are already spent. Reporting a bookkeeping
    // failure as "could not be reached" invites the one reaction that costs real
    // money — hiring again for a job that is already done and already paid for.
    const afterTheHire = JSON.stringify(model.prompts[2]);
    expect(afterTheHire).toContain("the big job is done");
    expect(afterTheHire).not.toContain("could not be reached");
    expect(texts(events)).toBe("All set.");
  });
});
