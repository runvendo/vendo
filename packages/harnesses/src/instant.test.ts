/**
 * `instant()` — the specialist. Every test here drives it through the REAL
 * harness runtime, because the failure mode this wave keeps producing is correct
 * code with no caller: a unit test of the router would not tell you a turn ever
 * reaches it.
 */
import {
  VENDO_MAKE_TOOL,
  VENDO_TOOL_TITLES,
  type MakeReceipt,
  type ThreadId,
  type ToolDescriptor,
} from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { instant } from "./instant.js";
import { createHarnessRuntime } from "./runtime.js";
import {
  boundRegistry,
  ctx,
  readSse,
  readTool,
  scriptedModel,
  seats,
  testGuard,
  testSkills,
  testTranscript,
  testWorkspace,
  toolCallTurn,
  textTurn,
  userMessage,
  type TestTool,
} from "./test-doubles.test-util.js";
import type { LanguageModel, UIMessage } from "ai";

const THREAD = "thr_instant" as ThreadId;

const makeTool = (): ToolDescriptor => ({
  ...readTool(VENDO_MAKE_TOOL, "read"),
  name: VENDO_MAKE_TOOL,
  title: VENDO_TOOL_TITLES[VENDO_MAKE_TOOL]!,
});

/** The receipt the tool hands back — four fields of WORDS. Never the document:
 *  the screen arrives on the view channel, and the harness only ever gets a line
 *  it can say. */
const receipt = (overrides: Partial<MakeReceipt> = {}): MakeReceipt => ({
  id: "app_7",
  title: "Spending",
  status: "ready",
  say: "Spending is on your screen.",
  ...overrides,
});

/** The apps pack's ONE hot tool, plus whatever else a case wants equipped. */
function appsRegistry(
  guard: ReturnType<typeof testGuard>,
  extra: Record<string, TestTool> = {},
  make: TestTool["execute"] = () => receipt(),
) {
  return boundRegistry(
    { [VENDO_MAKE_TOOL]: { descriptor: makeTool(), execute: make }, ...extra },
    guard,
  );
}

interface RunOptions {
  registry: ReturnType<typeof boundRegistry>;
  guard: ReturnType<typeof testGuard>;
  model: LanguageModel;
  messages?: UIMessage[];
  /** Already-persisted history. Server-authored messages can only arrive this
   *  way — `validateUpsert` refuses a client that posts an assistant turn. */
  seed?: UIMessage[];
}

async function runInstant(options: RunOptions) {
  const transcript = testTranscript();
  for (const [seq, message] of (options.seed ?? []).entries()) {
    await transcript.upsert({ kind: "user", subject: "u1" }, THREAD, message, seq);
  }
  const runtime = createHarnessRuntime({
    tools: options.registry,
    guard: options.guard,
    skills: testSkills(),
    transcript,
  });
  const parts = await readSse(
    await runtime.run({
      harness: instant(),
      threadId: THREAD,
      messages: options.messages ?? [userMessage("m1", "go")],
      ctx: ctx(),
      workspace: testWorkspace(),
      models: seats(options.model),
      interactive: true,
      system: "You serve Maple, a bank.",
    }),
  );
  return { parts, transcript };
}

/** Everything the assistant said this turn, joined. */
const saidBy = (parts: Array<Record<string, unknown>>): string =>
  parts
    .filter((part) => part.type === "text-delta")
    .map((part) => String(part.delta))
    .join("");

const toolInputs = (parts: Array<Record<string, unknown>>): Array<{ name: string; input: unknown }> =>
  parts
    .filter((part) => part.type === "tool-input-available")
    .map((part) => ({ name: String(part.toolName), input: part.input }));

describe("instant() — an app ask goes STRAIGHT to the apps tool", () => {
  it("routes a new screen with ONE model call and no resident loop", async () => {
    const guard = testGuard();
    const registry = appsRegistry(guard);
    const model = scriptedModel([
      toolCallTurn("route", { do: "create", prompt: "a spending dashboard for this month" }),
    ]);

    const { parts } = await runInstant({
      registry,
      guard,
      model,
      messages: [userMessage("m1", "build me a spending dashboard")],
    });

    // The whole point of the specialist: one routing call, then the pipeline.
    // A resident that had to "decide to use a tool" would cost a second one.
    expect(model.calls).toBe(1);
    expect(registry.invocations[VENDO_MAKE_TOOL]).toBe(1);
    // `app` is OMITTED, never blank: absent is what tells the seam to decide
    // new-or-continue, which is the whole reason the two tools became one.
    expect(toolInputs(parts)).toEqual([
      { name: VENDO_MAKE_TOOL, input: { request: "a spending dashboard for this month" } },
    ]);
    // The view is already on the user's screen; the assistant says the ONE line
    // the receipt handed it, rather than narrating.
    expect(saidBy(parts)).toBe("Spending is on your screen.");
  });

  it("changes the app the thread is already about, without being told its id", async () => {
    const guard = testGuard();
    const registry = appsRegistry(guard);
    const model = scriptedModel([
      toolCallTurn("route", { do: "edit", appId: "app_7", instruction: "make the chart a bar chart" }),
    ]);
    // The mirrored result of an earlier build — how a thread carries its app id.
    // It rides the RECEIPT's `id`, which is neither the `appId` the rest of the
    // family carries nor anything the generic sweep would find.
    const seed: UIMessage[] = [
      userMessage("m1", "build me a dashboard"),
      {
        id: "m2",
        role: "assistant",
        parts: [{
          type: "dynamic-tool",
          toolName: VENDO_MAKE_TOOL,
          toolCallId: "call_1",
          state: "output-available",
          input: { request: "a dashboard" },
          output: receipt(),
        }],
      } as unknown as UIMessage,
    ];

    const { parts } = await runInstant({
      registry,
      guard,
      model,
      seed,
      messages: [...seed, userMessage("m3", "make the chart a bar chart")],
    });

    expect(registry.invocations[VENDO_MAKE_TOOL]).toBe(1);
    expect(toolInputs(parts)).toEqual([
      { name: VENDO_MAKE_TOOL, input: { request: "make the chart a bar chart", app: "app_7" } },
    ]);
  });

  // The other half of the harvest, and the one nothing else covers: an app whose
  // id only ever appeared as an INPUT — the earlier change that ERRORED, so no
  // receipt was ever written. The honest scope in instant.ts says inputs count,
  // and without that read this thread looks appless and the change is refused.
  it("finds the app on a make call's own input when no receipt came back", async () => {
    const guard = testGuard();
    const registry = appsRegistry(guard);
    const model = scriptedModel([
      toolCallTurn("route", { do: "edit", appId: "app_12", instruction: "try a smaller table" }),
    ]);
    const seed: UIMessage[] = [
      userMessage("m1", "make the table bigger"),
      {
        id: "m2",
        role: "assistant",
        parts: [{
          type: "dynamic-tool",
          toolName: VENDO_MAKE_TOOL,
          toolCallId: "call_1",
          state: "output-error",
          input: { request: "make the table bigger", app: "app_12" },
          errorText: "app build failed: generation failed",
        }],
      } as unknown as UIMessage,
    ];

    const { parts } = await runInstant({
      registry,
      guard,
      model,
      seed,
      messages: [...seed, userMessage("m3", "try a smaller table")],
    });

    expect(toolInputs(parts)).toEqual([
      { name: VENDO_MAKE_TOOL, input: { request: "try a smaller table", app: "app_12" } },
    ]);
  });

  it("never routes to an apps tool the deployment did not equip", async () => {
    const guard = testGuard();
    // No apps pack: only a host tool.
    const registry = boundRegistry(
      { maple_balance: { descriptor: readTool("maple_balance"), execute: () => ({ balance: 12 }) } },
      guard,
    );
    const model = scriptedModel([
      // Router says "create" anyway — a model can always answer outside the world.
      toolCallTurn("route", { do: "create", prompt: "a dashboard" }),
      textTurn("I can tell you your balance instead."),
    ]);

    const { parts } = await runInstant({ registry, guard, model, messages: [userMessage("m1", "dashboard")] });

    expect(toolInputs(parts).map((call) => call.name)).not.toContain(VENDO_MAKE_TOOL);
    expect(saidBy(parts)).toContain("balance");
  });
});

describe("instant() — non-app asks still act, through the same guard door", () => {
  it("runs a host tool and reports back, capped so it is never a loop", async () => {
    const guard = testGuard();
    const registry = appsRegistry(guard, {
      maple_pay: { descriptor: readTool("maple_pay", "destructive"), execute: () => ({ paid: true }) },
    });
    const model = scriptedModel([
      toolCallTurn("route", { do: "act" }),
      toolCallTurn("maple_pay", { amount: 20 }),
      textTurn("Sent $20."),
    ]);

    const { parts } = await runInstant({
      registry,
      guard,
      model,
      messages: [userMessage("m1", "pay Ada $20")],
    });

    expect(registry.invocations["maple_pay"]).toBe(1);
    expect(saidBy(parts)).toContain("Sent $20.");
    // Router + act + report. A third acting step would be a thinking loop, and
    // instant() is the harness that does not have one.
    expect(model.calls).toBe(3);
  });

  it("leaves an audit row with the SAME shape vendo()'s guarded call leaves (E7)", async () => {
    const guard = testGuard();
    const registry = appsRegistry(guard, {
      maple_pay: { descriptor: readTool("maple_pay", "destructive"), execute: () => ({ paid: true }) },
    });
    const model = scriptedModel([
      toolCallTurn("route", { do: "act" }),
      toolCallTurn("maple_pay", { amount: 20 }),
      textTurn("Sent $20."),
    ]);

    await runInstant({ registry, guard, model, messages: [userMessage("m1", "pay Ada $20")] });

    const call = guard.events.find((event) => event.kind === "tool-call");
    expect(call).toMatchObject({
      kind: "tool-call",
      tool: "maple_pay",
      outcome: "ok",
      principal: { kind: "user", subject: "u1" },
      venue: "chat",
      presence: "present",
    });
    // And the turn's own row names the harness that ran, so metering can tell
    // instant() spend from vendo() spend.
    const run = guard.events.find((event) => event.kind === "run");
    expect(run?.detail).toMatchObject({ harness: "instant" });
  });
});

describe("instant() — the honest refusal", () => {
  it("says why in the consumer's voice and calls nothing", async () => {
    const guard = testGuard();
    const registry = appsRegistry(guard);
    const model = scriptedModel([
      toolCallTurn("route", {
        do: "cannot",
        reasons: ["Maple can't move money to an account outside your own."],
      }),
    ]);

    const { parts } = await runInstant({
      registry,
      guard,
      model,
      messages: [userMessage("m1", "wire $5k to my cousin")],
    });

    expect(toolInputs(parts)).toEqual([]);
    expect(saidBy(parts)).toContain("Maple can't move money to an account outside your own.");
    // No internals, no apology-with-a-stack-trace.
    expect(saidBy(parts)).not.toContain("route");
  });
});

/**
 * Both of these were found by running the real thing (Maple, 2026-08-01) after
 * the unit suite above was already green. They are the regressions for what the
 * live run showed, and neither is reachable from a scripted-happy-path test.
 */
describe("instant() — what the live run caught", () => {
  it("says something when a build fails, instead of a banner and silence", async () => {
    const guard = testGuard();
    const registry = appsRegistry(guard, {}, () => {
      throw new Error("app build failed: generation failed");
    });
    const model = scriptedModel([toolCallTurn("route", { do: "create", prompt: "a dashboard" })]);

    const { parts } = await runInstant({
      registry,
      guard,
      model,
      messages: [userMessage("m1", "build me a dashboard")],
    });

    // The build-failed banner is the shipped failure affordance and the bridge
    // still raises it. What was missing is the assistant's own sentence.
    expect(parts.some((part) => part.type === "data-vendo-build-failed")).toBe(true);
    expect(saidBy(parts)).toContain("couldn't put that together");
    // …and NOT a second, contentless error chunk on top of the banner.
    expect(parts.some((part) => part.type === "error")).toBe(false);
  });

  it("passes the pipeline's own refusal through instead of shrugging", async () => {
    const guard = testGuard();
    const registry = appsRegistry(guard, {}, () => {
      // The shape apps/runtime.ts throws for an honest `cannot`: the sentences
      // are the person's, verbatim.
      throw new Error(
        "app build failed: This host has machines disabled, so custom server code cannot run"
        + " — the weekly Friday summary cannot be automated.",
      );
    });
    const model = scriptedModel([toolCallTurn("route", { do: "create", prompt: "a weekly summary" })]);

    const { parts } = await runInstant({
      registry,
      guard,
      model,
      messages: [userMessage("m1", "every Friday, summarise my spending")],
    });

    expect(saidBy(parts)).toContain("machines disabled");
    expect(saidBy(parts)).not.toContain("couldn't put that together");
  });

  // A REJECTED change comes back OK — `status: "failed"` on the receipt, not an
  // error outcome — so the canned "Updated." the harness used to say was simply
  // a lie about a screen that never changed. The receipt's `say` is the only
  // line that knows what happened, and it is uttered verbatim.
  it("speaks the receipt's honest line when a change was refused, never 'Updated.'", async () => {
    const guard = testGuard();
    const registry = appsRegistry(
      guard,
      {},
      () => receipt({ status: "failed", say: "I couldn't make that change to Spending." }),
    );
    const model = scriptedModel([
      toolCallTurn("route", { do: "edit", appId: "app_7", instruction: "make it fetch my email" }),
    ]);
    const seed: UIMessage[] = [
      userMessage("m1", "build me a dashboard"),
      {
        id: "m2",
        role: "assistant",
        parts: [{
          type: "dynamic-tool",
          toolName: VENDO_MAKE_TOOL,
          toolCallId: "call_1",
          state: "output-available",
          input: { request: "a dashboard" },
          output: receipt(),
        }],
      } as unknown as UIMessage,
    ];

    const { parts } = await runInstant({
      registry,
      guard,
      model,
      seed,
      messages: [...seed, userMessage("m3", "make it fetch my email")],
    });

    expect(saidBy(parts)).toBe("I couldn't make that change to Spending.");
    expect(saidBy(parts)).not.toContain("Updated.");
  });

  it("does not change an app the conversation never produced", async () => {
    const guard = testGuard();
    const registry = appsRegistry(guard);
    const model = scriptedModel([
      // The router names an id that exists nowhere — what it does after a build
      // has failed and there is nothing on screen.
      toolCallTurn("route", { do: "edit", appId: "app_invented", instruction: "make it bigger" }),
      textTurn("There's nothing on screen yet — want me to build it?"),
    ]);

    const { parts } = await runInstant({
      registry,
      guard,
      model,
      messages: [userMessage("m1", "make the amount bigger")],
    });

    expect(registry.invocations[VENDO_MAKE_TOOL]).toBeUndefined();
    expect(saidBy(parts)).toContain("nothing on screen");
  });

  it("always ends with an answer, even when the acting steps are spent on tool calls", async () => {
    const guard = testGuard();
    const registry = appsRegistry(guard, {
      maple_account: {
        descriptor: readTool("maple_account"),
        execute: (args) => {
          // The first guess is wrong, exactly as it was live: an id the host
          // does not have. The second call is the one that works — and it lands
          // on the LAST acting step, so nothing is left to speak with.
          if ((args as { id?: string }).id !== undefined) throw new Error("Account not found");
          return { accounts: [{ name: "Maple Checking", balance: 941220 }] };
        },
      },
    });
    const model = scriptedModel([
      toolCallTurn("route", { do: "act" }),
      toolCallTurn("maple_account", { id: "acct_checking" }, "call_a"),
      toolCallTurn("maple_account", {}, "call_b"),
      textTurn("Your Maple Checking balance is $9,412.20."),
    ]);

    const { parts } = await runInstant({
      registry,
      guard,
      model,
      messages: [userMessage("m1", "what is my checking balance?")],
    });

    // Measured live (2026-08-01): the two acting steps went on a missed guess and
    // the retry, the cap ended the loop, and the person got two tool calls and
    // SILENCE while the answer sat in the tool result. A turn that acted and said
    // nothing is a failed turn whatever the status code.
    expect(saidBy(parts)).toContain("$9,412.20");
  });

  it("never refuses off a curated shortlist — the acting step is what looks", async () => {
    const guard = testGuard();
    // `find_tools` equipped means `list()` is a SUBSET. A router that answers
    // "cannot" from it is refusing on ignorance: measured live, a deployment
    // with Gmail connected but off the initial loadout answered "this product
    // cannot send emails".
    const registry = appsRegistry(guard, {
      find_tools: { descriptor: readTool("find_tools"), execute: () => ({ found: [] }) },
      maple_balance: { descriptor: readTool("maple_balance"), execute: () => ({ balance: 12 }) },
    });
    const model = scriptedModel([
      toolCallTurn("route", { do: "cannot", reasons: ["This product cannot send emails."] }),
      toolCallTurn("find_tools", { query: "email" }),
      textTurn("I looked; there's no way to email from here."),
    ]);

    const { parts } = await runInstant({
      registry,
      guard,
      model,
      messages: [userMessage("m1", "email me my balance")],
    });

    // The router's blind refusal never reached the person…
    expect(saidBy(parts)).not.toContain("This product cannot send emails.");
    // …and the acting step actually searched before answering.
    expect(registry.invocations["find_tools"]).toBe(1);
  });

  it("still refuses on the router's word when there is no discovery rail to consult", async () => {
    const guard = testGuard();
    const registry = appsRegistry(guard);
    const model = scriptedModel([
      toolCallTurn("route", { do: "cannot", reasons: ["Maple can't do that."] }),
    ]);
    const { parts } = await runInstant({
      registry,
      guard,
      model,
      messages: [userMessage("m1", "buy me a house")],
    });
    expect(saidBy(parts)).toContain("Maple can't do that.");
  });
});

describe("instant() — the cheap exits", () => {
  it("spends nothing when the caller already hung up", async () => {
    const guard = testGuard();
    const registry = appsRegistry(guard);
    const model = scriptedModel([]);
    const controller = new AbortController();
    controller.abort();

    const runtime = createHarnessRuntime({
      tools: registry,
      guard,
      skills: testSkills(),
      transcript: testTranscript(),
    });
    await readSse(
      await runtime.run({
        harness: instant(),
        threadId: THREAD,
        messages: [userMessage("m1", "build me a dashboard")],
        ctx: ctx(),
        workspace: testWorkspace(),
        models: seats(model),
        interactive: true,
        signal: controller.signal,
      }),
    );

    expect(model.calls).toBe(0);
  });

  it("reports a refused apps call as a refusal, not as a crash", async () => {
    const guard = testGuard({ [VENDO_MAKE_TOOL]: "block" });
    const registry = appsRegistry(guard);
    const model = scriptedModel([
      toolCallTurn("route", { do: "create", prompt: "a dashboard" }),
    ]);

    const { parts } = await runInstant({
      registry,
      guard,
      model,
      messages: [userMessage("m1", "build me a dashboard")],
    });

    expect(parts.some((part) => part.type === "error")).toBe(false);
    expect(saidBy(parts).length).toBeGreaterThan(0);
  });
});
