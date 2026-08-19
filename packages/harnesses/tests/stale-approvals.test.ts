/**
 * The two blockers from the final review.
 *
 * 1. A stale `approval-requested` PART must be flipped transcript-side at the
 *    start of every turn, exactly as the shipped loop's `abandonPendingApprovals`
 *    does. Resolving only the GUARD approval leaves the part pending forever, and
 *    `turnModelMessages` then yields an assistant tool-call with no tool-result —
 *    which providers 400 on, on every later turn. That is precisely the
 *    swap-resuming-from-our-transcript case E1 requires.
 * 2. Every approval RAISED during a turn must be abandoned at turn end, whichever
 *    path minted it — including one minted by the real dispatching check after the
 *    preview said "run" (a breaker or presence boundary). The one exception is the
 *    `interactive: false` card, which is meant to stand.
 */
import { providerHistory, turnModelMessages } from "../src/vendo/loop.js";
import type { ApprovalId, ThreadId } from "@vendoai/core";
import { convertToModelMessages, type ModelMessage, type UIMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
import { defineHarness } from "../src/define.js";
import { createHarnessRuntime } from "../src/runtime.js";
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

const THREAD = "thr_stale" as ThreadId;
const PRINCIPAL = { kind: "user" as const, subject: "u1" };

/** Every part a `ModelMessage` can carry. `flatMap` cannot pick one element type
 *  out of the per-role content union on its own. */
type ContentPart = Exclude<ModelMessage["content"], string>[number];

/** A transcript exactly as a `createAgent` turn left it: an undecided approval. */
function staleApprovalHistory(): UIMessage[] {
  return [
    userMessage("m1", "pay the invoice"),
    {
      id: "m2",
      role: "assistant",
      parts: [
        { type: "step-start" },
        {
          type: "dynamic-tool",
          toolName: "pay",
          toolCallId: "call_stale",
          state: "approval-requested",
          input: { amount: 1_400 },
          approval: { id: "sdk_apr_1" },
        },
        { type: "data-vendo-approval", data: { toolCallId: "call_stale", risk: "destructive", approvalId: "apr_stale" } },
      ],
    } as unknown as UIMessage,
  ];
}

/** How the provider will see a history: (tool-calls, tool-results). */
async function providerPairing(messages: UIMessage[]): Promise<{ calls: number; results: number }> {
  const model = await convertToModelMessages(providerHistory([...messages]));
  let calls = 0;
  let results = 0;
  for (const message of model) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type === "tool-call") calls += 1;
      if (part.type === "tool-result") results += 1;
    }
  }
  return { calls, results };
}

describe("1 — a stale approval-requested part is flipped at the start of a harness turn", () => {
  it("the transcript we inherit is genuinely unpaired (the bug's precondition)", async () => {
    // Sanity: without the flip this history is what 400s the provider.
    await expect(providerPairing(staleApprovalHistory())).resolves.toEqual({ calls: 1, results: 0 });
  });

  it("pairs the provider history after one harness turn", async () => {
    const guard = testGuard();
    const transcript = testTranscript();
    const history = staleApprovalHistory();
    for (const [seq, message] of history.entries()) {
      await transcript.upsert(PRINCIPAL, THREAD, message, seq);
    }
    const runtime = createHarnessRuntime({
      tools: boundRegistry({ pay: { descriptor: readTool("pay", "destructive"), execute: () => 1 } }, guard),
      guard,
      skills: testSkills(),
      transcript,
    });
    await readSse(
      await runtime.run({
        harness: defineHarness({
          name: "vendo",
          async *run() {
            yield { type: "text", delta: "Picking that back up." };
          },
        }),
        threadId: THREAD,
        // A fresh user turn, exactly as the shipped loop's trigger.
        messages: [...history, userMessage("m3", "still there?")],
        ctx: ctx(),
        workspace: testWorkspace(),
        models: unusedModels(),
        interactive: true,
      }),
    );

    const stored = await transcript.list(PRINCIPAL, THREAD);
    await expect(providerPairing(stored)).resolves.toEqual({ calls: 1, results: 1 });
  });

  it("the flip is the shipped one: approval-responded, approved false, reason abandoned", async () => {
    const guard = testGuard();
    const transcript = testTranscript();
    const history = staleApprovalHistory();
    for (const [seq, message] of history.entries()) {
      await transcript.upsert(PRINCIPAL, THREAD, message, seq);
    }
    const runtime = createHarnessRuntime({
      tools: boundRegistry({}, guard),
      guard,
      skills: testSkills(),
      transcript,
    });
    await readSse(
      await runtime.run({
        harness: defineHarness({ name: "vendo", async *run() {} }),
        threadId: THREAD,
        messages: [...history, userMessage("m3", "still there?")],
        ctx: ctx(),
        workspace: testWorkspace(),
        models: unusedModels(),
        interactive: true,
      }),
    );
    const stored = await transcript.list(PRINCIPAL, THREAD);
    const part = stored
      .flatMap((message) => message.parts)
      .find((candidate) => candidate.type === "dynamic-tool") as
      | { state?: string; approval?: { approved?: boolean; reason?: string } }
      | undefined;
    expect(part).toMatchObject({
      state: "approval-responded",
      approval: { approved: false, reason: "abandoned" },
    });
  });

  it("guard state and transcript state agree — the GUARD approval is resolved too", async () => {
    const guard = testGuard();
    const abandoned: ApprovalId[] = [];
    guard.abandonApprovals = async (ids) => {
      abandoned.push(...ids);
    };
    const transcript = testTranscript();
    const history = staleApprovalHistory();
    for (const [seq, message] of history.entries()) {
      await transcript.upsert(PRINCIPAL, THREAD, message, seq);
    }
    const runtime = createHarnessRuntime({
      tools: boundRegistry({}, guard),
      guard,
      skills: testSkills(),
      transcript,
    });
    await readSse(
      await runtime.run({
        harness: defineHarness({ name: "vendo", async *run() {} }),
        threadId: THREAD,
        messages: [...history, userMessage("m3", "still there?")],
        ctx: ctx(),
        workspace: testWorkspace(),
        models: unusedModels(),
        interactive: true,
      }),
    );
    // The guard's approvalId rides the `data-vendo-approval` part beside the tool
    // part; the runtime must read it from there, as the shipped loop does.
    expect(abandoned).toContain("apr_stale");
  });

  it("leaves the harness's own state alone — a flip is not an arbitrary edit", async () => {
    const guard = testGuard();
    const transcript = testTranscript();
    const history = staleApprovalHistory();
    for (const [seq, message] of history.entries()) {
      await transcript.upsert(PRINCIPAL, THREAD, message, seq);
    }
    const runtime = createHarnessRuntime({
      tools: boundRegistry({}, guard),
      guard,
      skills: testSkills(),
      transcript,
    });
    const seen: Array<string | undefined> = [];
    const remembering = defineHarness({
      name: "vendo",
      async *run(turn) {
        seen.push(turn.state.get());
        turn.state.set("session_1");
      },
    });
    const run = async (messages: UIMessage[]) =>
      readSse(
        await runtime.run({
          harness: remembering,
          threadId: THREAD,
          messages,
          ctx: ctx(),
          workspace: testWorkspace(),
          models: unusedModels(),
          interactive: true,
        }),
      );
    await run([...history, userMessage("m3", "one")]);
    const afterFirst = await transcript.list(PRINCIPAL, THREAD);
    await run([...afterFirst, userMessage("m4", "two")]);
    // Turn 2 must still see the session: the runtime's OWN flip must not be
    // mistaken for the user rewriting history.
    expect(seen).toEqual([undefined, "session_1"]);
  });

  it("does not need turnModelMessages to be re-derived — the loop's own converter agrees", async () => {
    const { messages: paired } = await turnModelMessages({
      messages: [
        userMessage("m1", "hi"),
        {
          id: "m2",
          role: "assistant",
          parts: [
            {
              type: "dynamic-tool",
              toolName: "pay",
              toolCallId: "c1",
              state: "approval-responded",
              input: {},
              approval: { id: "a1", approved: false, reason: "abandoned" },
            },
          ],
        } as unknown as UIMessage,
      ],
      system: "system",
    });
    const calls = paired.flatMap((m): readonly ContentPart[] => (Array.isArray(m.content) ? m.content : [])).filter((p) => p.type === "tool-call");
    const results = paired.flatMap((m): readonly ContentPart[] => (Array.isArray(m.content) ? m.content : [])).filter((p) => p.type === "tool-result");
    expect([calls.length, results.length]).toEqual([1, 1]);
  });
});

describe("2 — every approval raised in a turn is abandoned, whichever path minted it", () => {
  /** The breaker/presence boundary: the PREVIEW says run, the real check asks. */
  function lateAskGuard() {
    const guard = testGuard();
    guard.previewCheck = async () => ({ action: "run", decidedBy: "default" });
    return guard;
  }

  it("abandons an approval minted by the real dispatching check", async () => {
    const guard = lateAskGuard();
    const abandoned: ApprovalId[] = [];
    guard.abandonApprovals = async (ids) => {
      abandoned.push(...ids);
      for (const id of ids) guard.decide(id, false);
    };
    // policy "ask" applies to the REAL check only, since previewCheck is stubbed.
    const registry = boundRegistry(
      { pay: { descriptor: readTool("pay", "destructive"), execute: () => 1 } },
      testGuard({ pay: "ask" }),
    );
    const runtime = createHarnessRuntime({
      tools: registry,
      guard,
      skills: testSkills(),
      transcript: testTranscript(),
      approvalWaitMs: 15,
    });
    await readSse(
      await runtime.run({
        harness: defineHarness({
          name: "payer",
          async *run(turn) {
            const result = await turn.tools.call("pay", { amount: 10 });
            expect(result.status).toBe("denied");
          },
        }),
        threadId: THREAD,
        messages: [userMessage("m1", "pay")],
        ctx: ctx(),
        workspace: testWorkspace(),
        models: unusedModels(),
        interactive: true,
      }),
    );
    // Nobody could ever answer this one — it must not leak into the queue.
    await vi.waitFor(() => expect(abandoned.length).toBeGreaterThan(0));
  });

  it("does NOT abandon the interactive:false card — standing is correct by design", async () => {
    const guard = testGuard({ pay: "ask" });
    const abandoned: ApprovalId[] = [];
    guard.abandonApprovals = async (ids) => {
      abandoned.push(...ids);
    };
    const runtime = createHarnessRuntime({
      tools: boundRegistry({ pay: { descriptor: readTool("pay", "destructive"), execute: () => 1 } }, guard),
      guard,
      skills: testSkills(),
      transcript: testTranscript(),
    });
    await readSse(
      await runtime.run({
        harness: defineHarness({
          name: "payer",
          async *run(turn) {
            const result = await turn.tools.call("pay", { amount: 10 });
            expect(result.status).toBe("denied");
          },
        }),
        threadId: THREAD,
        messages: [userMessage("m1", "pay")],
        ctx: ctx(),
        workspace: testWorkspace(),
        models: unusedModels(),
        // Nobody is here: the card stands so "Grant & re-run" can collect it.
        interactive: false,
      }),
    );
    expect(abandoned).toEqual([]);
    expect(guard.pending()).toHaveLength(1);
  });
});

/**
 * 3. The same law as (1), for the refusals §1.4 mints when the CONSENT is
 *    missing: nobody was here to tap, the check could not run, or the guard asked
 *    a second time. None of them is a person's no, and none of them has an
 *    approval on the tool part — so writing them as the ai-SDK's `output-denied`
 *    (whose conversion reads `approval.reason`) left a transcript that THREW on
 *    every later turn in the thread. An automation that hits a standing grant
 *    dies from then on, which is exactly the case (1) exists for.
 */
describe("3 — a refusal nobody was asked about leaves a transcript the next turn can send", () => {
  /** The prompt the NEXT turn assembles from what this one persisted — the loop's
   *  own path, which is where an unconvertible part throws. */
  async function nextTurnPairing(stored: UIMessage[]): Promise<{ calls: number; results: number }> {
    const { messages } = await turnModelMessages({
      messages: [...stored, userMessage("m_next", "and now?")],
      system: "system",
    });
    const content = messages.flatMap((message): readonly ContentPart[] =>
      Array.isArray(message.content) ? message.content : []);
    return {
      calls: content.filter((part) => part.type === "tool-call").length,
      results: content.filter((part) => part.type === "tool-result").length,
    };
  }

  /** One real turn whose single call is refused, and what it left behind. */
  async function refusedTurn(options: {
    guard: TestGuard;
    interactive: boolean;
    /** The guard the REGISTRY is bound to, when the case needs the real
     *  dispatching check to disagree with the preview. */
    registryGuard?: TestGuard;
  }): Promise<{ stored: UIMessage[]; reason: string }> {
    const transcript = testTranscript();
    const tools = { pay: { descriptor: readTool("pay", "destructive"), execute: () => 1 } };
    const runtime = createHarnessRuntime({
      tools: boundRegistry(tools, options.registryGuard ?? options.guard),
      guard: options.guard,
      skills: testSkills(),
      transcript,
      approvalWaitMs: 15,
    });
    let reason = "";
    await readSse(
      await runtime.run({
        harness: defineHarness({
          name: "payer",
          async *run(turn) {
            const result = await turn.tools.call("pay", { amount: 10 });
            if (result.status === "denied") reason = result.reason;
            // The turn CARRIES ON past the refusal, in words, exactly as it did
            // before — that much always worked, and this is what made the next
            // turn's death so quiet.
            yield { type: "text", delta: `refused: ${reason}` };
          },
        }),
        threadId: THREAD,
        messages: [userMessage("m1", "pay")],
        // Presence follows the case: an unattended turn is one nobody is AT, and
        // the refusal it speaks says so — a present turn that merely does not
        // block gets a different sentence (turn-tools.ts).
        ctx: ctx({ presence: options.interactive ? "present" : "away" }),
        workspace: testWorkspace(),
        models: unusedModels(),
        interactive: options.interactive,
      }),
    );
    return { stored: await transcript.list(PRINCIPAL, THREAD), reason };
  }

  /** The one settled tool part the turn left, and what it settled as. */
  const settled = (stored: UIMessage[]): { state?: string; output?: { status?: string; reason?: string } } =>
    stored.flatMap((message) => message.parts)
      .find((part) => part.type === "dynamic-tool") as never;

  it("the unattended park: the card stands, and the thread is still sendable", async () => {
    const guard = testGuard({ pay: "ask" });
    // Nobody is here to tap — the automation case.
    const { stored, reason } = await refusedTurn({ guard, interactive: false });

    expect(reason).toBe("This needs your approval, and nobody is here to give it.");
    // THE symptom first: the next turn's own prompt assembly, over what this
    // turn persisted.
    await expect(nextTurnPairing(stored)).resolves.toEqual({ calls: 1, results: 1 });
    expect(settled(stored)).toMatchObject({
      state: "output-available",
      output: { status: "blocked", reason },
    });
    // The grant "Grant & re-run" collects is the GUARD's, and it still stands:
    // nothing about it was ever read off the tool part.
    expect(guard.pending()).toHaveLength(1);
  });

  it("the check that could not run: no id to wait on, still sendable", async () => {
    const guard = testGuard({ pay: "ask" });
    // The guard fails closed and mints no approval at all (tool-bridge.ts).
    guard.previewCheck = async () => {
      throw new Error("the guard is down");
    };
    const { stored, reason } = await refusedTurn({ guard, interactive: true });

    expect(reason).toBe("This needs approval, and the check could not run.");
    // THE symptom first: the next turn's own prompt assembly, over what this
    // turn persisted.
    await expect(nextTurnPairing(stored)).resolves.toEqual({ calls: 1, results: 1 });
    expect(settled(stored)).toMatchObject({
      state: "output-available",
      output: { status: "blocked", reason },
    });
  });

  it("the guard asking twice for one tap: still sendable", async () => {
    // The PREVIEW says run; the real dispatching check asks (a breaker or a
    // presence boundary), and refusing to raise a second card is the honest
    // answer — but it is still nobody's decline.
    const guard = testGuard();
    guard.previewCheck = async () => ({ action: "run", decidedBy: "default" });
    const { stored, reason } = await refusedTurn({
      guard,
      interactive: true,
      registryGuard: testGuard({ pay: "ask" }),
    });

    expect(reason).toBe("This still needs approval.");
    // THE symptom first: the next turn's own prompt assembly, over what this
    // turn persisted.
    await expect(nextTurnPairing(stored)).resolves.toEqual({ calls: 1, results: 1 });
    expect(settled(stored)).toMatchObject({
      state: "output-available",
      output: { status: "blocked", reason },
    });
  });

  it("a person's own no is untouched — that IS what output-denied means", async () => {
    const guard = testGuard({ pay: "ask" });
    // The card is raised, and the person turns it down.
    guard.onApprovalDecision(() => undefined);
    const transcript = testTranscript();
    const runtime = createHarnessRuntime({
      tools: boundRegistry({ pay: { descriptor: readTool("pay", "destructive"), execute: () => 1 } }, guard),
      guard,
      skills: testSkills(),
      transcript,
      approvalWaitMs: 5_000,
    });
    const turn = readSse(
      await runtime.run({
        harness: defineHarness({
          name: "payer",
          async *run(turn) {
            const result = await turn.tools.call("pay", { amount: 10 });
            yield { type: "text", delta: result.status === "denied" ? result.reason : "ran" };
          },
        }),
        threadId: THREAD,
        messages: [userMessage("m1", "pay")],
        ctx: ctx(),
        workspace: testWorkspace(),
        models: unusedModels(),
        interactive: true,
      }),
    );
    await vi.waitFor(() => expect(guard.pending()).toHaveLength(1));
    guard.decide(guard.pending()[0]!.id, false);
    const chunks = await turn;

    expect(chunks.some((chunk) => chunk.type === "tool-output-denied")).toBe(true);
    const stored = await transcript.list(PRINCIPAL, THREAD);
    expect(settled(stored)).toMatchObject({ state: "output-denied" });
    // And it converts, because the ask it answers is on the part beside it.
    await expect(nextTurnPairing(stored)).resolves.toEqual({ calls: 1, results: 1 });
  });
});
