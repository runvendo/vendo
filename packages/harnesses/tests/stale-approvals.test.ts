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
import { convertToModelMessages, type UIMessage } from "ai";
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
} from "../src/test-doubles.test-util.js";

const THREAD = "thr_stale" as ThreadId;
const PRINCIPAL = { kind: "user" as const, subject: "u1" };

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
    const calls = paired.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((p) => p.type === "tool-call");
    const results = paired.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((p) => p.type === "tool-result");
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
