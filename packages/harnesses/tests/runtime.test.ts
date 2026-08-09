/**
 * The runtime — build contract §1.6 ("@vendoai/harnesses owns the runtime").
 * It builds the Turn, converts HarnessEvents plus mirrored tool calls into the
 * EXISTING ai-SDK UIMessage stream, persists the transcript, and enforces the
 * frozen routing table. Harness adapters contain no persistence and no wire code.
 */
import { wrapWorkspaceForRender } from "@vendoai/apps";
import { defineHarness } from "../src/define.js";
import { SSE_KEEPALIVE_FRAME, type Harness, type HarnessEvent, type ThreadId, type Turn } from "@vendoai/core";
import type { UIMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
import { createHarnessRuntime, type TurnRunInput } from "../src/runtime.js";
import { memoryHarnessStateStore } from "../src/harness-state.js";
import {
  boundRegistry,
  ctx,
  readSse,
  readTool,
  testGuard,
  testSkills,
  testTranscript,
  testWorkspace,
  unusedModels,
  userMessage,
  type TestGuard,
} from "../src/test-doubles.test-util.js";

const THREAD = "thr_1" as ThreadId;

/** A harness that just replays a scripted event list — the runtime is what is
 *  under test, so the thinker is deliberately not one. */
function scripted(events: HarnessEvent[], name = "scripted"): Harness {
  return defineHarness({
    name,
    async *run() {
      for (const event of events) yield event;
    },
  });
}

function fixture(options: {
  guard?: TestGuard;
  tools?: Record<string, { descriptor: ReturnType<typeof readTool>; execute: () => unknown }>;
  transcript?: ReturnType<typeof testTranscript>;
  harnessState?: ReturnType<typeof memoryHarnessStateStore>;
  /** Composition's publish hook — how the process's own doors (and the steer
   *  route) reach the turn in flight. */
  liveTurn?: Parameters<typeof createHarnessRuntime>[0]["liveTurn"];
  /** Fill the runtime's generic `wrapWorkspace` slot with the REAL render seam,
   *  exactly as composition does (harness-turn.ts) — the runtime itself no
   *  longer wraps anything on its own. */
  seam?: boolean;
} = {}) {
  const guard = options.guard ?? testGuard();
  const registry = boundRegistry(
    (options.tools ?? {}) as Parameters<typeof boundRegistry>[0],
    guard,
  );
  const transcript = options.transcript ?? testTranscript();
  const upserts: Array<{ id: string; seq: number }> = [];
  const countingTranscript = {
    ...transcript,
    upsert: async (...args: Parameters<typeof transcript.upsert>) => {
      upserts.push({ id: args[2].id, seq: args[3] });
      return transcript.upsert(...args);
    },
  };
  const runtime = createHarnessRuntime({
    tools: registry,
    guard,
    skills: testSkills([{ name: "building-apps", description: "how to build an app", body: "# body" }]),
    transcript: countingTranscript,
    harnessState: options.harnessState ?? memoryHarnessStateStore(),
    ...(options.liveTurn === undefined ? {} : { liveTurn: options.liveTurn }),
    ...(options.seam === true ? {
      wrapWorkspace: (workspace, opts) => wrapWorkspaceForRender(workspace, {
        turnId: opts.turnId,
        emit: opts.emit,
      }),
    } : {}),
  });
  /** Run a turn AND drain the response, exactly as a host route does. The
   *  stream's onFinish (persistence, state, audit) only fires on consumption —
   *  an unread body means the client hung up. Returns the SSE parts. */
  const runRaw = (harness: Harness, over: Partial<TurnRunInput> = {}): Promise<Response> =>
    runtime.run({
      harness,
      threadId: THREAD,
      messages: [userMessage("m1", "hello")],
      ctx: ctx(),
      workspace: testWorkspace(),
      models: unusedModels(),
      interactive: true,
      ...over,
    });
  const run = async (
    harness: Harness,
    over: Partial<TurnRunInput> = {},
  ): Promise<Array<Record<string, unknown>>> => readSse(await runRaw(harness, over));
  return { guard, registry, transcript, upserts, runtime, run, runRaw };
}

/** The messages the runtime persisted, oldest → newest. */
const persisted = async (f: ReturnType<typeof fixture>): Promise<UIMessage[]> =>
  f.transcript.list({ kind: "user", subject: "u1" }, THREAD);

describe("turn assembly", () => {
  it("hands the harness the canonical transcript, oldest → newest, read-only", async () => {
    let seen: Turn | undefined;
    const f = fixture();
    const harness = defineHarness({
      name: "peek",
      async *run(turn) {
        seen = turn;
      },
    });
    await f.run(harness, { messages: [userMessage("m1", "first"), userMessage("m2", "second")] });
    expect(seen!.messages.map((message) => message.id)).toEqual(["m1", "m2"]);
    expect(Object.isFrozen(seen!.messages)).toBe(true);
  });

  it("forwards interactive, options, workspace, models and skills", async () => {
    let seen: Turn<{ depth: number }> | undefined;
    const f = fixture();
    const workspace = testWorkspace({ "/user/memory/a.md": "alpha" });
    const models = unusedModels();
    const harness = defineHarness<{ depth: number }>({
      name: "peek",
      async *run(turn) {
        seen = turn;
      },
    });
    await f.run(harness as unknown as Harness, {
      interactive: false,
      options: { depth: 3 },
      workspace,
      models,
    });
    expect(seen!.interactive).toBe(false);
    expect(seen!.options).toEqual({ depth: 3 });
    expect(seen!.models).toBe(models);
    await expect(seen!.workspace.readFile("/user/memory/a.md")).resolves.toBe("alpha");
    await expect(seen!.skills.list()).resolves.toEqual([
      { name: "building-apps", description: "how to build an app" },
    ]);
    await expect(seen!.skills.load("building-apps")).resolves.toBe("# body");
  });

  it("attaches the turn's transcript to the ctx the guard reads (RunContext.messages)", async () => {
    // Agents spec 2026-08-04: guards and judges weigh a call against what the
    // user actually asked, so the ctx that reaches `guard.check` carries a
    // transcript accessor — the SAME frozen view the harness holds.
    const seen: Parameters<TestGuard["check"]>[2][] = [];
    const base = testGuard();
    const guard: TestGuard = {
      ...base,
      check: async (call, descriptor, runCtx) => {
        seen.push(runCtx);
        return base.check(call, descriptor, runCtx);
      },
    };
    const f = fixture({
      guard,
      tools: { ping: { descriptor: readTool("ping"), execute: () => ({ ok: true }) } },
    });
    const harness = defineHarness({
      name: "caller",
      async *run(turn) {
        await turn.tools.call("ping", {});
      },
    });
    await f.run(harness, { messages: [userMessage("m1", "first"), userMessage("m2", "second")] });
    // Every check this call produced (preview and execute both consult the
    // guard) saw the same enriched ctx.
    expect(seen.length).toBeGreaterThan(0);
    for (const runCtx of seen) {
      expect(runCtx.messages?.().map((message) => message.id)).toEqual(["m1", "m2"]);
    }
    expect(Object.isFrozen(seen[0]!.messages?.())).toBe(true);
  });

  it("gives the harness a live abort signal", async () => {
    const f = fixture();
    const controller = new AbortController();
    let aborted: boolean | undefined;
    const harness = defineHarness({
      name: "abortable",
      async *run(turn) {
        controller.abort();
        aborted = turn.signal.aborted;
      },
    });
    await f.run(harness, { signal: controller.signal });
    expect(aborted).toBe(true);
  });

  it("a harness that yields nothing still produces a well-formed stream", async () => {
    const f = fixture();
    // Empty but well-formed is the established behaviour (today's agent closes
    // the same way on a pre-turn abort): the terminator is what a client needs.
    // The keepalive rides in front of it (core/sse-keepalive.ts) — an SSE comment
    // frame, so "empty" now means "one frame of nothing, then the terminator".
    const raw = await (await f.runRaw(scripted([]))).text();
    expect(raw).toBe(`${SSE_KEEPALIVE_FRAME}data: [DONE]\n\n`);
  });
});

describe("routing — text → screen + transcript", () => {
  it("streams the deltas to the screen", async () => {
    const f = fixture();
    const parts = await f.run(
      scripted([
        { type: "text", delta: "Hello " },
        { type: "text", delta: "world" },
      ]),
    );
    const deltas = parts.filter((part) => part.type === "text-delta").map((part) => part.delta);
    expect(deltas).toEqual(["Hello ", "world"]);
  });

  it("lands in the transcript as one assistant text part", async () => {
    const f = fixture();
    await f.run(scripted([{ type: "text", delta: "Hello " }, { type: "text", delta: "world" }]));
    const messages = await persisted(f);
    const last = messages.at(-1)!;
    expect(last.role).toBe("assistant");
    expect(last.parts.filter((part) => part.type === "text")).toEqual([
      { type: "text", text: "Hello world", state: "done" },
    ]);
  });
});

describe("routing — status → screen ONLY", () => {
  it("reaches the screen", async () => {
    const f = fixture();
    const parts = await f.run(scripted([{ type: "status", label: "Checking your invoices" }]));
    const status = parts.find((part) => String(part.type).startsWith("data-vendo-status"));
    expect(status).toMatchObject({ data: { label: "Checking your invoices" }, transient: true });
  });

  it("never reaches the transcript — it is ephemeral by contract", async () => {
    const f = fixture();
    await f.run(
      scripted([{ type: "status", label: "Checking your invoices" }, { type: "text", delta: "Done." }]),
    );
    const messages = await persisted(f);
    expect(JSON.stringify(messages)).not.toContain("Checking your invoices");
  });
});

describe("routing — error → screen + transcript + audit", () => {
  const boom: HarnessEvent = { type: "error", message: "I couldn't reach your bank.", code: "upstream" };

  it("raises today's ai-SDK error chunk — the banner, Retry and detail line", async () => {
    const f = fixture();
    const parts = await f.run(scripted([boom]));
    const error = parts.find((part) => part.type === "error");
    expect(error).toEqual({ type: "error", errorText: "I couldn't reach your bank." });
  });

  it("does NOT splice the sentence into the assistant's prose", async () => {
    const f = fixture();
    const parts = await f.run(scripted([{ type: "text", delta: "Let me look. " }, boom]));
    const said = parts
      .filter((part) => part.type === "text-delta")
      .map((part) => part.delta)
      .join("");
    expect(said).toBe("Let me look. ");
  });

  it("reaches the audit trail", async () => {
    const f = fixture();
    await f.run(scripted([boom]));
    const audited = f.guard.events.filter((event) => event.kind === "run");
    expect(audited).toHaveLength(1);
    expect(JSON.stringify(audited[0]!.detail)).toContain("upstream");
  });

  it("a harness that throws mid-run becomes an honest error, not a crash", async () => {
    const f = fixture();
    const harness = defineHarness({
      name: "explodes",
      async *run() {
        yield { type: "text", delta: "starting" };
        throw new Error("SECRET_KEY=abc123 leaked internals");
      },
    });
    const parts = await f.run(harness);
    const serialized = JSON.stringify(parts);
    // Consumer-voice law: no internals ever reach an end user.
    expect(serialized).not.toContain("SECRET_KEY");
    expect(serialized).not.toContain("leaked internals");
    expect(f.guard.events.some((event) => event.kind === "run")).toBe(true);
  });
});

describe("routing — usage → audit/metering ONLY", () => {
  const usage: HarnessEvent = {
    type: "usage",
    inputTokens: 1200,
    outputTokens: 340,
    cacheReadTokens: 900,
    model: "claude-fable-5",
  };

  it("never reaches the screen", async () => {
    const f = fixture();
    const parts = await f.run(scripted([usage, { type: "text", delta: "done" }]));
    expect(JSON.stringify(parts)).not.toContain("1200");
    expect(JSON.stringify(parts)).not.toContain("claude-fable-5");
  });

  it("never reaches the transcript — billing does not depend on the story layer", async () => {
    const f = fixture();
    await f.run(scripted([usage, { type: "text", delta: "done" }]));
    expect(JSON.stringify(await persisted(f))).not.toContain("1200");
  });

  it("reaches the audit trail with its figures", async () => {
    const f = fixture();
    await f.run(scripted([usage]));
    const run = f.guard.events.find((event) => event.kind === "run");
    expect(run?.detail).toMatchObject({
      usage: { inputTokens: 1200, outputTokens: 340, cacheReadTokens: 900, model: "claude-fable-5" },
    });
  });

  it("sums repeated usage events across a turn", async () => {
    const f = fixture();
    await f.run(scripted([usage, { type: "usage", inputTokens: 100, outputTokens: 10 }]));
    const run = f.guard.events.find((event) => event.kind === "run");
    expect(run?.detail).toMatchObject({ usage: { inputTokens: 1300, outputTokens: 350 } });
  });
});

describe("mirroring — tool calls are the runtime's job, never a yield", () => {
  const tools = {
    maple_invoices_list: { descriptor: readTool("maple_invoices_list"), execute: () => ({ count: 2 }) },
  };

  function callingHarness(): Harness {
    return defineHarness({
      name: "caller",
      async *run(turn) {
        const result = await turn.tools.call("maple_invoices_list", {});
        yield { type: "text", delta: result.status === "ok" ? "You have 2." : "I couldn't look." };
      },
    });
  }

  it("puts the call and its output on the screen without the harness yielding either", async () => {
    const f = fixture({ tools });
    const parts = await f.run(callingHarness());
    expect(parts.some((part) => part.type === "tool-input-available")).toBe(true);
    expect(parts.some((part) => part.type === "tool-output-available")).toBe(true);
    const input = parts.find((part) => part.type === "tool-input-available")!;
    expect(input).toMatchObject({ toolName: "maple_invoices_list", dynamic: true });
  });

  it("puts the call in the transcript beside the assistant's words", async () => {
    const f = fixture({ tools });
    await f.run(callingHarness());
    const last = (await persisted(f)).at(-1)!;
    expect(last.parts.some((part) => part.type === "dynamic-tool")).toBe(true);
    expect(last.parts.some((part) => part.type === "text")).toBe(true);
  });

  it("mirrors a denied call as denied, not as an output", async () => {
    const f = fixture({ guard: testGuard({ maple_invoices_list: "block" }), tools });
    const parts = await f.run(callingHarness());
    expect(parts.some((part) => part.type === "tool-output-denied")).toBe(true);
    expect(parts.some((part) => part.type === "tool-output-available")).toBe(false);
  });

  it("mirrors an errored call as an error", async () => {
    const f = fixture({
      tools: {
        maple_invoices_list: {
          descriptor: readTool("maple_invoices_list"),
          execute: () => {
            throw new Error("upstream 500");
          },
        },
      },
    });
    const parts = await f.run(callingHarness());
    expect(parts.some((part) => part.type === "tool-output-error")).toBe(true);
  });

  it("raises today's data-vendo-approval part when the guard asks", async () => {
    const guard = testGuard({ maple_pay: "ask" });
    const f = fixture({
      guard,
      tools: { maple_pay: { descriptor: readTool("maple_pay", "destructive"), execute: () => 1 } },
    });
    const harness = defineHarness({
      name: "payer",
      async *run(turn) {
        const result = await turn.tools.call("maple_pay", { amount: 10 });
        yield { type: "text", delta: result.status };
      },
    });
    // Nobody is here to tap, so the unattended branch answers immediately (§1.4).
    const parts = await f.run(harness, { interactive: false });
    const card = parts.find((part) => part.type === "data-vendo-approval");
    expect(card).toMatchObject({ data: { risk: "destructive" } });
  });
});

describe("transcript persistence — the write law", () => {
  it("writes one row per message, and only for what changed", async () => {
    const transcript = testTranscript();
    const f = fixture({ transcript });
    await f.run(scripted([{ type: "text", delta: "one" }]), {
      messages: [userMessage("m1", "hello")],
    });
    // Turn 1: the new user message + the new assistant message. Two rows.
    expect(f.upserts).toHaveLength(2);

    const afterFirst = await persisted(f);
    f.upserts.length = 0;
    await f.run(scripted([{ type: "text", delta: "two" }]), {
      messages: [...afterFirst, userMessage("m2", "again")],
    });
    // Turn 2 re-sends the whole history but only two rows are new.
    expect(f.upserts).toHaveLength(2);
    expect(f.upserts.map((row) => row.id)).toContain("m2");
  });

  it("orders by seq, never by timestamp", async () => {
    const f = fixture();
    await f.run(scripted([{ type: "text", delta: "reply" }]));
    const rows = [...f.upserts].sort((left, right) => left.seq - right.seq);
    expect(rows.map((row) => row.seq)).toEqual([0, 1]);
    const messages = await persisted(f);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  });

  it("is O(messages), not O(tokens) — a long reply is still one row", async () => {
    const f = fixture();
    const manyDeltas: HarnessEvent[] = Array.from({ length: 500 }, () => ({
      type: "text" as const,
      delta: "x",
    }));
    await f.run(scripted(manyDeltas));
    expect(f.upserts).toHaveLength(2);
    const last = (await persisted(f)).at(-1)!;
    expect((last.parts[0] as { text: string }).text).toHaveLength(500);
  });

  it("a store outage does not corrupt the already-delivered reply", async () => {
    const f = fixture();
    f.transcript.upsert = async () => {
      throw new Error("store is down");
    };
    const runtime = createHarnessRuntime({
      tools: f.registry,
      guard: f.guard,
      skills: testSkills(),
      transcript: f.transcript,
    });
    const response = await runtime.run({
      harness: scripted([{ type: "text", delta: "delivered anyway" }]),
      threadId: THREAD,
      messages: [userMessage("m1", "hello")],
      ctx: ctx(),
      workspace: testWorkspace(),
      models: unusedModels(),
      interactive: true,
    });
    expect(JSON.stringify(await readSse(response))).toContain("delivered anyway");
  });
});

describe("turn.state across turns (§1.3)", () => {
  const remembering = (name: string, seen: Array<string | undefined>): Harness =>
    defineHarness({
      name,
      async *run(turn) {
        seen.push(turn.state.get());
        turn.state.set(`session_for_${name}`);
      },
    });

  it("persists at turn end and comes back next turn", async () => {
    const harnessState = memoryHarnessStateStore();
    const f = fixture({ harnessState });
    const seen: Array<string | undefined> = [];
    await f.run(remembering("vendo", seen));
    const history = await persisted(f);
    await f.run(remembering("vendo", seen), { messages: [...history, userMessage("m2", "again")] });
    expect(seen).toEqual([undefined, "session_for_vendo"]);
  });

  it("a harness swap starts clean", async () => {
    const harnessState = memoryHarnessStateStore();
    const f = fixture({ harnessState });
    const seen: Array<string | undefined> = [];
    await f.run(remembering("vendo", seen));
    const history = await persisted(f);
    await f.run(remembering("claude-code", seen), {
      messages: [...history, userMessage("m2", "again")],
    });
    expect(seen).toEqual([undefined, undefined]);
  });

  it("an arbitrary history edit clears it", async () => {
    const harnessState = memoryHarnessStateStore();
    const f = fixture({ harnessState });
    const seen: Array<string | undefined> = [];
    await f.run(remembering("vendo", seen), {
      messages: [userMessage("m1", "hello"), userMessage("m2", "second")],
    });
    const history = await persisted(f);
    // A message deleted from the MIDDLE: `validateUpsert` permits it (nothing is
    // rewritten) but the conversation the harness's session describes no longer
    // exists, so the session must go.
    await f.run(remembering("vendo", seen), {
      messages: [history[0]!, ...history.slice(2)],
    });
    expect(seen).toEqual([undefined, undefined]);
  });

  it("a client that rewrites history is REJECTED, not silently accepted", async () => {
    const f = fixture();
    await f.run(scripted([{ type: "text", delta: "hi" }]));
    // The shipped rule: a caller may add fresh user messages and answer
    // approvals. Rewriting an existing one is a history-forging attempt.
    await expect(
      f.runRaw(scripted([]), { messages: [userMessage("m1", "something entirely different")] }),
    ).rejects.toThrow(/cannot be rewritten/);
  });

  it("a prefix truncation keeps it — the harness rewinds natively", async () => {
    const harnessState = memoryHarnessStateStore();
    const f = fixture({ harnessState });
    const seen: Array<string | undefined> = [];
    await f.run(remembering("vendo", seen), {
      messages: [userMessage("m1", "hello"), userMessage("m2", "second")],
    });
    const history = await persisted(f);
    await f.run(remembering("vendo", seen), { messages: history.slice(0, 1) });
    expect(seen).toEqual([undefined, "session_for_vendo"]);
  });
});

describe("the render seam rides the wrapWorkspace slot (§1.6)", () => {
  // The runtime no longer imports the seam: composition injects it through the
  // generic `wrapWorkspace` slot, which `seam: true` reproduces here. What these
  // pin is the SLOT — the wrap sees every commit, and its `emit` reaches the
  // wire's view channel.
  it("a harness writing plan.vendo puts the skeleton on screen", async () => {
    const f = fixture({ seam: true });
    const harness = defineHarness({
      name: "builder",
      async *run(turn) {
        yield { type: "status", label: "Sketching the layout" };
        await turn.workspace.writeFile(
          "/user/apps/app_7/plan.vendo",
          `<Plan name="Invoices"><Group title="Unpaid"><Leaf component="DataTable" /></Group></Plan>`,
        );
      },
    });
    const parts = await f.run(harness);
    const view = parts.find((part) => part.type === "data-vendo-view");
    expect(view).toBeDefined();
    expect(view).toMatchObject({ id: "vendo-view:app_7", data: { appId: "app_7" } });
  });

  it("an unparseable write puts nothing on screen", async () => {
    const f = fixture({ seam: true });
    const harness = defineHarness({
      name: "builder",
      async *run(turn) {
        await turn.workspace.writeFile("/user/apps/app_7/app.vendo", "half-written garba");
      },
    });
    const parts = await f.run(harness);
    expect(parts.some((part) => part.type === "data-vendo-view")).toBe(false);
  });
});

describe("write = commit for in-process hands (§3.5 + the commit-cadence seam)", () => {
  const PLAN = `<Plan name="Invoices"><Group title="Unpaid"><Leaf component="DataTable" /></Group></Plan>`;

  it("a workspace tool edit lands on its own call, not at turn end", async () => {
    const workspace = testWorkspace();
    // Stands in for lane D's workspace_write: the tool stages, the runtime lands it.
    const f = fixture({
      seam: true,
      tools: {
        workspace_write: {
          descriptor: readTool("workspace_write", "write"),
          execute: () => {
            void workspace.writeFile("/user/apps/app_9/plan.vendo", PLAN);
            return { written: true };
          },
        },
      },
    });
    const harness = defineHarness({
      name: "editor",
      async *run(turn) {
        await turn.tools.call("workspace_write", {});
        // The commit already happened, so the view is on the wire BEFORE the
        // harness says anything.
        expect(workspace.commits).toHaveLength(1);
        expect(workspace.commits[0]!.changed).toEqual(["/user/apps/app_9/plan.vendo"]);
        yield { type: "text", delta: "Done." };
      },
    });
    const parts = await f.run(harness, { workspace });
    expect(parts.some((part) => part.type === "data-vendo-view")).toBe(true);
  });

  it("turn end lands whatever the harness staged and never committed", async () => {
    const workspace = testWorkspace();
    const f = fixture();
    const harness = defineHarness({
      name: "note-taker",
      async *run(turn) {
        await turn.workspace.writeFile("/user/memory/what-i-learned.md", "she prefers weekly digests");
        yield { type: "text", delta: "Noted." };
      },
    });
    await f.run(harness, { workspace });
    expect(workspace.commits.at(-1)?.changed).toEqual(["/user/memory/what-i-learned.md"]);
  });

  it("a commit that fails does not take the turn down with it", async () => {
    const workspace = testWorkspace();
    workspace.commit = async () => {
      throw new Error("the store is unreachable");
    };
    const f = fixture();
    const parts = await f.run(scripted([{ type: "text", delta: "delivered anyway" }]), { workspace });
    expect(JSON.stringify(parts)).toContain("delivered anyway");
  });
});

describe("the runtime never lets a harness reach the wire itself", () => {
  it("cleans up its approval subscription even when the harness throws", async () => {
    const guard = testGuard();
    const unsubscribe = vi.fn();
    guard.onApprovalDecision = () => unsubscribe;
    const f = fixture({ guard });
    await f.run(
      defineHarness({
        name: "explodes",
        async *run() {
          throw new Error("nope");
        },
      }),
    );
    expect(unsubscribe).toHaveBeenCalled();
  });
});

describe("mid-build steering — the user's words joining a turn already running (§10.2)", () => {
  it("the steered words land in the transcript exactly once, in order, at their own seq", async () => {
    // TRAP 2. `persistTurn` writes one row per message at ITS INDEX in the turn's
    // own message array, at turn end. A side-channel write to the store cannot
    // know that index — it lands at the seq the ASSISTANT message will claim, and
    // `seq` is the only ordering authority the transcript has (store schema.ts).
    // Two rows at one seq is an undefined read order: the user's steer can render
    // after the reply it caused. So the message must join the in-flight turn's own
    // list and be persisted by the same pass as everything else.
    let steer: ((text: string, messageId: string) => Promise<boolean>) | undefined;
    const f = fixture({
      liveTurn: (published) => {
        steer = published.steer;
        return () => undefined;
      },
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const heard: string[] = [];
    const harness = defineHarness({
      name: "steerable",
      async *run(turn) {
        turn.onSteer?.(async (text) => {
          heard.push(text);
          return true;
        });
        yield { type: "text", delta: "building it" };
        await released;
        yield { type: "text", delta: " — regrouping by client." };
      },
    });

    const running = f.run(harness, { messages: [userMessage("m1", "build me a workbench")] });
    await vi.waitFor(() => expect(steer).toBeDefined());
    await expect(steer!("group by client instead", "m_steer")).resolves.toBe(true);
    release();
    await running;

    // The harness heard it — same turn, no second send.
    expect(heard).toEqual(["group by client instead"]);
    // The transcript reads user · steer · assistant, and every seq is distinct.
    const rows = await persisted(f);
    expect(rows.map((message) => message.id)).toEqual(["m1", "m_steer", expect.any(String)]);
    expect(rows.map((message) => message.role)).toEqual(["user", "user", "assistant"]);
    const seqs = f.upserts.filter((row) => row.id === "m_steer" || row.id === "m1");
    expect(seqs).toEqual([{ id: "m1", seq: 0 }, { id: "m_steer", seq: 1 }]);
    // Exactly once: no duplicate row, from either the checkpoint pass or onFinish.
    expect(f.upserts.filter((row) => row.id === "m_steer")).toHaveLength(1);
    // Nothing shares the assistant's seq.
    const assistantSeq = f.upserts.find((row) => row.id !== "m1" && row.id !== "m_steer")!.seq;
    expect(assistantSeq).toBe(2);
  });

  it("a harness that never registers a handler makes the steer NOT land, and nothing is written", async () => {
    // No capability protocol anywhere: not registering IS the answer, and the
    // caller's own queue is the fallback.
    let steer: ((text: string, messageId: string) => Promise<boolean>) | undefined;
    const f = fixture({
      liveTurn: (published) => {
        steer = published.steer;
        return () => undefined;
      },
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const harness = defineHarness({
      name: "deaf",
      async *run() {
        yield { type: "text", delta: "working" };
        await released;
      },
    });
    const running = f.run(harness, { messages: [userMessage("m1", "hello")] });
    await vi.waitFor(() => expect(steer).toBeDefined());
    await expect(steer!("are you there", "m_steer")).resolves.toBe(false);
    release();
    await running;

    expect((await persisted(f)).map((message) => message.id)).toEqual(["m1", expect.any(String)]);
    expect(f.upserts.filter((row) => row.id === "m_steer")).toHaveLength(0);
  });

  it("a steer rides the SAME turn — same turnId, same ctx, same audit context (§3.5)", async () => {
    let steer: ((text: string, messageId: string) => Promise<boolean>) | undefined;
    let publishedTurnId: string | undefined;
    let harnessTurnId: string | undefined;
    const f = fixture({
      liveTurn: (published) => {
        steer = published.steer;
        publishedTurnId = published.ctx.turnId;
        return () => undefined;
      },
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let seenAtSteer: string | undefined;
    const harness = defineHarness({
      name: "same-turn",
      async *run(turn) {
        harnessTurnId = turn.turnId;
        turn.onSteer?.(async () => {
          // Read INSIDE the steer: whatever answers it must be this turn.
          seenAtSteer = turn.turnId;
          return true;
        });
        yield { type: "text", delta: "working" };
        await released;
      },
    });
    const running = f.run(harness, { messages: [userMessage("m1", "hello")] });
    await vi.waitFor(() => expect(steer).toBeDefined());
    await steer!("and group by client", "m_steer");
    release();
    await running;

    expect(harnessTurnId).toMatch(/^trn_[0-9a-f]{32}$/);
    expect(seenAtSteer).toBe(harnessTurnId);
    expect(publishedTurnId).toBe(harnessTurnId);
  });
});
