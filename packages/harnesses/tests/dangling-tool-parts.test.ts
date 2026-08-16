/**
 * The abort invariant is ENFORCED, not raced for — the runtime drops unpaired
 * tool parts at persist time, so a mid-call abort can never land a dangling
 * tool call in the transcript for a provider to reject later.
 *
 * (Escalation A of the receipts-era suite; the hire-receipt half of that file
 * died with the receipt path — usage folding is pinned in runtime.test.ts and
 * vendo/ledger.test.ts.)
 */
import type { ThreadId } from "@vendoai/core";
import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
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

const THREAD = "thr_dangling" as ThreadId;

function fixture(tools: Parameters<typeof boundRegistry>[0] = {}) {
  const guard = testGuard();
  const registry = boundRegistry(tools, guard);
  const transcript = testTranscript();
  const runtime = createHarnessRuntime({
    tools: registry,
    guard,
    skills: testSkills(),
    transcript,
  });
  const run = async (harness: Parameters<typeof runtime.run>[0]["harness"]) =>
    readSse(
      await runtime.run({
        harness,
        threadId: THREAD,
        messages: [userMessage("m1", "go")],
        ctx: ctx(),
        workspace: testWorkspace(),
        models: unusedModels(),
        interactive: true,
      }),
    );
  const persisted = (): Promise<UIMessage[]> =>
    transcript.list({ kind: "user", subject: "u1" }, THREAD);
  return { guard, run, persisted };
}

describe("an unpaired tool part never reaches the transcript", () => {
  it("drops a call the turn ended before resolving", async () => {
    let release: (() => void) | undefined;
    const f = fixture({
      slow: {
        descriptor: readTool("slow"),
        // Never settles until the test lets it, so the turn ends mid-call.
        execute: () => new Promise((resolve) => {
          release = () => resolve({ done: true });
        }) as never,
      },
    });
    const parts = await f.run(
      defineHarness({
        name: "impatient",
        async *run(turn) {
          // Deliberately NOT awaited: the generator returns while the call is
          // still in flight, exactly as an abort mid-execution leaves it.
          void turn.tools.call("slow", {});
          yield { type: "text", delta: "not waiting" };
        },
      }),
    );
    // The call WAS announced on the wire (the user saw it start)…
    expect(parts.some((part) => part.type === "tool-input-available")).toBe(true);
    release?.();

    // …but the persisted transcript must not carry a tool call with no result:
    // `convertToModelMessages` would turn it into an assistant tool-call with no
    // matching tool-result, which providers reject.
    const stored = await f.persisted();
    const dangling = stored.flatMap((message) =>
      message.parts.filter((part) => {
        const state = (part as { state?: string }).state;
        return (
          (part.type === "dynamic-tool" || part.type.startsWith("tool-"))
          && (state === "input-available" || state === "input-streaming")
        );
      }),
    );
    expect(dangling).toEqual([]);
  });

  it("keeps a tool part that resolved", async () => {
    const f = fixture({ look: { descriptor: readTool("look"), execute: () => ({ found: 1 }) } });
    await f.run(
      defineHarness({
        name: "patient",
        async *run(turn) {
          await turn.tools.call("look", {});
          yield { type: "text", delta: "found one" };
        },
      }),
    );
    const stored = await f.persisted();
    const resolved = stored.flatMap((message) =>
      message.parts.filter((part) => (part as { state?: string }).state === "output-available"),
    );
    expect(resolved).toHaveLength(1);
  });

  it("keeps a tool part waiting on a HUMAN — that is not dangling", async () => {
    // `approval-requested` is the one pending state the client legitimately
    // flips, so pruning must never touch it.
    const guard = testGuard({ pay: "ask" });
    const registry = boundRegistry(
      { pay: { descriptor: readTool("pay", "destructive"), execute: () => 1 } },
      guard,
    );
    const transcript = testTranscript();
    const runtime = createHarnessRuntime({
      tools: registry,
      guard,
      skills: testSkills(),
      transcript,
      approvalWaitMs: 10,
    });
    await readSse(
      await runtime.run({
        harness: defineHarness({
          name: "payer",
          async *run(turn) {
            await turn.tools.call("pay", { amount: 1 });
            yield { type: "text", delta: "asked" };
          },
        }),
        threadId: THREAD,
        messages: [userMessage("m1", "pay")],
        ctx: ctx(),
        workspace: testWorkspace(),
        models: unusedModels(),
        interactive: false,
      }),
    );
    const stored = await transcript.list({ kind: "user", subject: "u1" }, THREAD);
    // The refusal is recorded (a settled `blocked` outcome — nobody was here to
    // decline it), and nothing was silently pruned.
    expect(stored.at(-1)!.parts.some((part) => part.type === "dynamic-tool")).toBe(true);
  });
});
