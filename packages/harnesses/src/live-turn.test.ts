/**
 * `HarnessRuntimeDeps.liveTurn` — the runtime publishing the turn in flight to
 * the host process's own doors (the MCP door's turn credential, 10-mcp §3b).
 *
 * The load-bearing property is IDENTITY, not shape. The door answers a
 * turn-bearing call with `published.tools.call()`, and the parity gate's claim
 * that this mirrors to the transcript and runs `workspace.commit()` rests
 * entirely on that being the SAME object the harness holds as `turn.tools` —
 * the wrapper the runtime built, not the raw `createTurnTools` surface
 * underneath it, which mirrors but does not commit.
 *
 * A future refactor that hands the door a fresh `{ list, call }` façade would
 * pass every behavioural test in the parity gate and silently drop the commit,
 * so the identity is asserted directly.
 */
import type { Harness, HarnessEvent, ThreadId, Turn, TurnTools } from "@vendoai/core";
import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { defineHarness } from "./define.js";
import { createHarnessRuntime } from "./runtime.js";
import {
  boundRegistry,
  ctx,
  readTool,
  testGuard,
  testSkills,
  testTranscript,
  testWorkspace,
  unusedModels,
  userMessage,
} from "./test-doubles.test-util.js";

const THREAD = "thr_live" as ThreadId;
const RUN_CTX = ctx();

interface Published {
  threadId: ThreadId;
  ctx: unknown;
  tools: TurnTools;
}

async function runWith(harness: Harness, publish: (published: Published) => () => void) {
  const guard = testGuard();
  const runtime = createHarnessRuntime({
    tools: boundRegistry(
      { host_lookup: { descriptor: readTool("host_lookup"), execute: () => ({ ok: true }) } } as never,
      guard,
    ),
    guard,
    skills: testSkills(),
    transcript: testTranscript(),
    liveTurn: publish as never,
  });
  const response = await runtime.run({
    harness,
    threadId: THREAD,
    messages: [userMessage("m1", "hello")] as UIMessage[],
    ctx: RUN_CTX,
    workspace: testWorkspace({}),
    models: unusedModels(),
    interactive: true,
  });
  await response.text();
}

describe("the runtime publishes the turn in flight", () => {
  it("publishes the harness's OWN tool surface — the same object, so mirror and commit cannot be bypassed", async () => {
    let held: TurnTools | undefined;
    let published: Published | undefined;
    const harness: Harness = defineHarness({
      name: "grabber",
      async *run(turn: Turn): AsyncGenerator<HarnessEvent, void, void> {
        held = turn.tools;
        yield { type: "text", delta: "ok" };
      },
    });
    await runWith(harness, (value) => {
      published = value;
      return () => undefined;
    });

    expect(published).toBeDefined();
    expect(published!.threadId).toBe(THREAD);
    // The published ctx is the TURN's ctx: the caller's fields plus what the
    // runtime attaches — the transcript accessor (RunContext.messages) and the
    // turn id it minted (§3.5). A call arriving over the door is therefore
    // audited against the same turn the harness's own calls are.
    const { messages, ...rest } = published!.ctx as Record<string, unknown>;
    expect(rest).toEqual({ ...RUN_CTX, turnId: expect.stringMatching(/^trn_[0-9a-f]{32}$/) });
    expect((messages as () => UIMessage[])().map((message) => message.id)).toEqual(["m1"]);
    // THE assertion: not "an equivalent surface", the SAME one.
    expect(published!.tools).toBe(held);
  });

  it("publishes BEFORE the harness runs and retracts when the turn ends", async () => {
    const order: string[] = [];
    const harness: Harness = defineHarness({
      name: "orderly",
      async *run(): AsyncGenerator<HarnessEvent, void, void> {
        order.push("harness");
        yield { type: "text", delta: "ok" };
      },
    });
    await runWith(harness, () => {
      order.push("publish");
      return () => order.push("retract");
    });
    // Published first (a box opens its MCP session on the turn's first act) and
    // retracted last, so no call can be attributed to a turn that has ended.
    expect(order).toEqual(["publish", "harness", "retract"]);
  });

  it("retracts even when the harness throws — a crashed turn must not leave a live credential", async () => {
    const order: string[] = [];
    const harness: Harness = defineHarness({
      name: "thrower",
      // eslint-disable-next-line require-yield
      async *run(): AsyncGenerator<HarnessEvent, void, void> {
        throw new Error("thinker exploded");
      },
    });
    await runWith(harness, () => {
      order.push("publish");
      return () => order.push("retract");
    });
    expect(order).toEqual(["publish", "retract"]);
  });

  it("is optional: a runtime nobody wired a door into runs exactly as before", async () => {
    const guard = testGuard();
    const runtime = createHarnessRuntime({
      tools: boundRegistry({} as never, guard),
      guard,
      skills: testSkills(),
      transcript: testTranscript(),
    });
    const response = await runtime.run({
      harness: defineHarness({
        name: "plain",
        async *run(): AsyncGenerator<HarnessEvent, void, void> {
          yield { type: "text", delta: "hi" };
        },
      }),
      threadId: THREAD,
      messages: [userMessage("m1", "hello")] as UIMessage[],
      ctx,
      workspace: testWorkspace({}),
      models: unusedModels(),
      interactive: true,
    });
    expect(await response.text()).toContain("hi");
  });
});
