/**
 * self-serve P, on the runtime — the two behaviours the `createAgent` door owned
 * and this one did not: a failed turn KEEPS its reason, and a retry does not
 * inherit it.
 *
 * The ai-SDK `error` chunk belongs to no message: it sets the client's transient
 * error and is gone on the next mount, so a reloaded thread showed the user's
 * question answered by a blank reply. Everything below is asserted against what
 * the TRANSCRIPT holds — the real read path — not against the live stream, since
 * the live stream was never the part that was broken.
 */
import type { ThreadId } from "@vendoai/core";
import type { UIMessage } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineHarness } from "./define.js";
import { createHarnessRuntime } from "./runtime.js";
import {
  boundRegistry,
  ctx,
  readSse,
  testGuard,
  testSkills,
  testTranscript,
  testWorkspace,
  unusedModels,
  userMessage,
} from "./test-doubles.test-util.js";

const THREAD = "thr_turn_error" as ThreadId;

afterEach(() => {
  vi.restoreAllMocks();
});

function runtimeFor(overrides: Partial<Parameters<typeof createHarnessRuntime>[0]> = {}) {
  const guard = testGuard();
  const transcript = testTranscript();
  const runtime = createHarnessRuntime({
    tools: boundRegistry({}, guard),
    guard,
    skills: testSkills(),
    transcript,
    ...overrides,
  });
  const run = async (
    harness: Parameters<typeof runtime.run>[0]["harness"],
    messages: UIMessage[] = [userMessage("m1", "go")],
  ) => readSse(await runtime.run({
    harness,
    threadId: THREAD,
    messages,
    ctx: ctx(),
    workspace: testWorkspace(),
    models: unusedModels(),
    interactive: true,
  }));
  return { run, transcript };
}

const failing = defineHarness({
  name: "failing",
  async *run() {
    yield { type: "error", message: "I could not reach your reports just now.", code: "upstream" };
  },
});

const turnErrors = (messages: readonly UIMessage[]) =>
  messages.flatMap((message) => message.parts).filter((part) => part.type === "data-vendo-turn-error");

describe("a failed turn keeps its reason in the transcript", () => {
  it("persists one data-vendo-turn-error part carrying the sentence the user saw", async () => {
    const { run, transcript } = runtimeFor();
    const parts = await run(failing);

    // The screen's affordance is unchanged — the banner still gets its chunk.
    expect(parts.find((part) => part.type === "error")?.errorText)
      .toBe("I could not reach your reports just now.");

    const stored = await transcript.list(ctx().principal, THREAD);
    const notices = turnErrors(stored);
    expect(notices).toHaveLength(1);
    expect((notices[0] as { data?: { message?: string } }).data?.message)
      .toBe("I could not reach your reports just now.");
  });

  it("records a turn that dies BEFORE the harness runs, instead of persisting blank", async () => {
    // `liveTurn` is a composition seam called on the way into the turn, so it
    // stands for every failure the harness's own event loop can never see.
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { run, transcript } = runtimeFor({
      liveTurn: () => { throw new Error("turn credential mint failed at https://door/key=sk-123"); },
    });
    await run(defineHarness({ name: "never-reached", async *run() { yield { type: "text", delta: "hi" }; } }));

    const notices = turnErrors(await transcript.list(ctx().principal, THREAD));
    expect(notices).toHaveLength(1);
    // The user's sentence, never the internals — the same posture the wire's
    // error text already has.
    expect((notices[0] as { data?: { message?: string } }).data?.message)
      .toBe("Something went wrong on my side, so I stopped.");
    expect(JSON.stringify(notices)).not.toContain("sk-123");
  });

  it("records ONCE per turn — the stream's own gate re-runs over the chunk we wrote", async () => {
    const { run, transcript } = runtimeFor();
    await run(failing);
    expect(turnErrors(await transcript.list(ctx().principal, THREAD))).toHaveLength(1);
  });

  it("leaves no notice on a turn that merely had a tool fail and carried on", async () => {
    // A failing tool is a recoverable beat, not a failed turn: a notice here
    // would render a permanent failure above a successful answer.
    const guard = testGuard();
    const registry = boundRegistry({
      broken: {
        descriptor: { name: "broken", description: "throws", inputSchema: { type: "object" }, risk: "read" },
        execute: () => { throw new Error("upstream 500"); },
      },
    }, guard);
    const { run, transcript } = runtimeFor({ tools: registry, guard });
    await run(defineHarness({
      name: "recovers",
      async *run(turn) {
        await turn.tools.call("broken", {});
        yield { type: "text", delta: "Recovered without it." };
      },
    }));

    expect(turnErrors(await transcript.list(ctx().principal, THREAD))).toHaveLength(0);
  });
});

describe("a retry never inherits the failed turn's notice", () => {
  it("the keyless → key → Retry flow reloads clean, over the WHOLE thread", async () => {
    const { run, transcript } = runtimeFor();
    await run(failing);

    // What the door re-sends on Retry: the stored thread, ending with the
    // errored assistant turn the ai-SDK will CONTINUE.
    const before = await transcript.list(ctx().principal, THREAD);
    expect(turnErrors(before)).toHaveLength(1);
    await run(
      defineHarness({
        name: "answers",
        async *run() { yield { type: "text", delta: "Here is your dashboard." }; },
      }),
      before,
    );

    // Asserted over the whole thread, not just the tail: persistence writes one
    // row per message and can only add or replace, so a notice left behind would
    // sit ABOVE the answer and never show up in a tail-only check.
    const after = await transcript.list(ctx().principal, THREAD);
    expect(turnErrors(after)).toHaveLength(0);
    expect(after.filter((message) => message.role === "user")).toHaveLength(1);
    expect(JSON.stringify(after)).toContain("Here is your dashboard.");
  });

  it("clears it on the ai-SDK's OWN retry, which posts the history without the failed reply", async () => {
    const { run, transcript } = runtimeFor();
    await run(failing);

    // The shape the door actually receives: `regenerate()` slices the assistant
    // message it is replacing off the transcript before posting it (ai's
    // `Chat.regenerate`), so the record to clear is only in the STORE. Handing
    // the runtime the stored thread intact — as the case above does — is a shape
    // no client sends, and it hid this for a whole review window.
    const before = await transcript.list(ctx().principal, THREAD);
    expect(turnErrors(before)).toHaveLength(1);
    await run(
      defineHarness({
        name: "answers",
        async *run() { yield { type: "text", delta: "Here is your dashboard." }; },
      }),
      before.filter((message) => message.role === "user"),
    );

    const after = await transcript.list(ctx().principal, THREAD);
    expect(turnErrors(after)).toHaveLength(0);
    // The retry CONTINUES the failed reply rather than landing a second one
    // under it — one question, one answer, on reload as on screen.
    expect(after.filter((message) => message.role === "assistant")).toHaveLength(1);
    expect(JSON.stringify(after)).toContain("Here is your dashboard.");
  });
});

describe("ENG-309 — a store blip does not cost the turn", () => {
  it("retries the persist before it gives up, and says nothing when the retry lands", async () => {
    const logged: unknown[][] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { logged.push(args); });
    const transcript = testTranscript();
    const real = transcript.upsert.bind(transcript);
    let attempts = 0;
    transcript.upsert = async (...args) => {
      attempts += 1;
      if (attempts === 1) throw new Error("store blip");
      await real(...args);
    };
    const { run } = runtimeFor({ transcript });

    await run(defineHarness({
      name: "answers",
      async *run() { yield { type: "text", delta: "Saved on the second try." }; },
    }));

    expect(attempts).toBeGreaterThan(1);
    expect(JSON.stringify(await transcript.list(ctx().principal, THREAD)))
      .toContain("Saved on the second try.");
    expect(logged.some((args) => String(args[0]).includes("this turn was NOT saved"))).toBe(false);
  });

  it("names the loss LOUDLY once the retries are spent", async () => {
    const logged: unknown[][] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { logged.push(args); });
    const transcript = testTranscript();
    transcript.upsert = async () => { throw new Error("store down"); };
    const { run } = runtimeFor({ transcript });

    await run(defineHarness({
      name: "answers",
      async *run() { yield { type: "text", delta: "never saved" }; },
    }));

    const loud = logged.find((args) => String(args[0]).includes("this turn was NOT saved"));
    expect(loud).toBeDefined();
    expect((loud?.[1] as { attempts?: number }).attempts).toBe(3);
  });
});
