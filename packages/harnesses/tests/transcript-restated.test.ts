/**
 * The two transcript passes a composed turn cannot fail, and no longer runs.
 *
 * `run()` opens by re-validating every incoming message against the stored
 * history (`validateUpsert`, a double stringify of each message's parts) and then
 * re-classifying the two histories against each other (`classifyHistory`). On the
 * composed chat path both are decided before they start: `harness-turn.ts` answers
 * `transcript.list` with the very array it passes as `messages`, having already
 * validated the one message the client contributed. One array cannot differ from
 * itself — so every upsert matches, the history is "append", and the whole O(n)
 * pass per turn is spent proving a tautology.
 *
 * The skip is keyed on that identity and nothing else, which is what keeps it
 * PROVABLE: any caller whose stored history is a different array — a client-posted
 * transcript, the away runner, a host's own runtime — still takes both checks in
 * full. The last test here is that guarantee.
 */
import { defineHarness } from "../src/define.js";
import type { Harness, ThreadId } from "@vendoai/core";
import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { createHarnessRuntime } from "../src/runtime.js";
import { memoryHarnessStateStore } from "../src/harness-state.js";
import {
  boundRegistry,
  ctx,
  readSse,
  testGuard,
  testSkills,
  testWorkspace,
  unusedModels,
} from "../src/test-doubles.test-util.js";

const THREAD = "thr_restated" as ThreadId;

/** A message that counts every read of its `parts` — the field both passes walk,
 *  and the only way to see from outside whether they walked it. */
function countingMessage(id: string, text: string, reads: { count: number }): UIMessage {
  const parts = [{ type: "text", text }];
  return Object.defineProperty({ id, role: "user" } as UIMessage, "parts", {
    enumerable: true,
    get() {
      reads.count += 1;
      return parts;
    },
  });
}

const scripted = (): Harness => defineHarness({
  name: "scripted",
  async *run() {
    yield { type: "text", delta: "ok" };
  },
});

/** One turn over `messages`, with the stored history the caller chooses. */
async function turn(
  messages: UIMessage[],
  stored: (messages: UIMessage[]) => UIMessage[],
): Promise<void> {
  const guard = testGuard();
  const runtime = createHarnessRuntime({
    tools: boundRegistry({}, guard),
    guard,
    skills: testSkills([]),
    transcript: {
      upsert: async () => {},
      list: async () => stored(messages),
    },
    harnessState: memoryHarnessStateStore(),
  });
  await readSse(await runtime.run({
    harness: scripted(),
    threadId: THREAD,
    messages,
    ctx: ctx(),
    workspace: testWorkspace(),
    models: unusedModels(),
    interactive: true,
  }));
}

describe("the composed turn's restated transcript", () => {
  it("walks the messages FEWER times when the stored history is the turn's own array", async () => {
    // The history a real thread carries by the time the passes cost anything:
    // the composed path re-states all of it every turn.
    const history = (reads: { count: number }): UIMessage[] =>
      Array.from({ length: 6 }, (_, index) => countingMessage(`m${index}`, `line ${index}`, reads));

    // What the composed path used to hand the runtime: its own deep copy, so
    // both passes compare every message against a structurally equal twin.
    const copied = { count: 0 };
    await turn(history(copied), (messages) => messages.map((message) => structuredClone(message)));

    // What it hands the runtime now: the same array it is running.
    const same = { count: 0 };
    await turn(history(same), (messages) => messages);

    expect(same.count).toBeLessThan(copied.count);
  });

  it("still validates and classifies in full when the stored history is a DIFFERENT array", async () => {
    // A client replaying a known id with different parts is the forgery the
    // upsert rule exists to refuse. The stored copy is its own array here, so
    // the fast path cannot apply and the rule has to fire.
    const guard = testGuard();
    const stored: UIMessage[] = [
      { id: "m1", role: "user", parts: [{ type: "text", text: "the real ask" }] } as UIMessage,
    ];
    const runtime = createHarnessRuntime({
      tools: boundRegistry({}, guard),
      guard,
      skills: testSkills([]),
      transcript: { upsert: async () => {}, list: async () => stored.map((m) => structuredClone(m)) },
      harnessState: memoryHarnessStateStore(),
    });

    await expect(runtime.run({
      harness: scripted(),
      threadId: THREAD,
      messages: [
        { id: "m1", role: "user", parts: [{ type: "text", text: "a rewritten ask" }] } as UIMessage,
      ],
      ctx: ctx(),
      workspace: testWorkspace(),
      models: unusedModels(),
      interactive: true,
    })).rejects.toThrow(/existing user message cannot be rewritten/);
  });
});
