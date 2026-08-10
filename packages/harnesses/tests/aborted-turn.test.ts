/**
 * A turn cut short reports itself.
 *
 * The ai-SDK ends an aborted stream with an `abort` part that carries no error and
 * drops whatever error was behind it, so a harness has nothing to report and stops
 * quietly — `vendo.ts`'s `case "abort": return`. That silence used to reach the
 * caller as a SUCCESS: a truncated reply, no error chunk on the wire, no
 * `data-vendo-turn-error` part in the transcript, and no `error` on the run row.
 * Anything measuring the product from outside (a host's own retry, the bench's
 * lane reader) then graded a half-written answer as a finished one.
 *
 * The failure channel is the RUNTIME's and the event stream is the thinker's, and
 * the two are separate on purpose: a harness that hung up has by definition
 * nothing more to yield, so nothing here adds an event to the harness's stream.
 */
import type { AuditEvent, Harness, ThreadId } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { defineHarness } from "../src/define.js";
import { createHarnessRuntime } from "../src/runtime.js";
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
} from "../src/test-doubles.test-util.js";

const THREAD = "thr_abort" as ThreadId;

/** One turn, driven and drained exactly as a host route does — the run row only
 *  lands on consumption. */
async function driveTurn(harness: Harness, signal?: AbortSignal): Promise<{
  parts: Array<Record<string, unknown>>;
  runs: AuditEvent[];
}> {
  const guard = testGuard();
  const runtime = createHarnessRuntime({
    tools: boundRegistry({}, guard),
    guard,
    skills: testSkills(),
    transcript: testTranscript(),
  });
  const parts = await readSse(
    await runtime.run({
      harness,
      threadId: THREAD,
      messages: [userMessage("m1", "move the money")],
      ctx: ctx(),
      workspace: testWorkspace(),
      models: unusedModels(),
      interactive: true,
      ...(signal === undefined ? {} : { signal }),
    }),
  );
  return { parts, runs: guard.events.filter((event) => event.kind === "run") };
}

/** The harness that says nothing about it: half a reply, then the caller hangs up
 *  and it returns — the shipped `abort` path, without a provider in the test. */
const cutShort = (controller: AbortController): Harness =>
  defineHarness({
    name: "cut-short",
    async *run() {
      yield { type: "text", delta: "Transferring $4" };
      controller.abort();
    },
  });

describe("an aborted turn is a failed turn", () => {
  it("puts the failure on the wire, in the transcript and on the run row", async () => {
    const controller = new AbortController();

    const { parts, runs } = await driveTurn(cutShort(controller), controller.signal);

    // The screen's banner and Retry…
    expect(parts.filter((part) => part.type === "error")).toHaveLength(1);
    // …the transcript's record, so a reload of a cut-short turn does not show the
    // half reply as the whole answer…
    expect(parts.filter((part) => part.type === "data-vendo-turn-error")).toHaveLength(1);
    // …and the audit row, which is what a caller counting failures reads.
    expect(runs).toHaveLength(1);
    expect((runs[0]!.detail as { error?: { code?: string } }).error?.code).toBe("aborted");
    // The half reply it did manage still reaches the user — the abort is reported
    // beside what was said, never instead of it.
    expect(parts.filter((part) => part.type === "text-delta")).toHaveLength(1);
  });

  it("says nothing of the sort about a turn that finished", async () => {
    const { parts, runs } = await driveTurn(
      defineHarness({
        name: "finished",
        async *run() {
          yield { type: "text", delta: "Done." };
        },
      }),
    );

    expect(parts.filter((part) => part.type === "error")).toEqual([]);
    expect(parts.filter((part) => part.type === "data-vendo-turn-error")).toEqual([]);
    expect(runs).toEqual([]);
  });

  it("keeps the failure the harness reported, rather than restamping it as an abort", async () => {
    const controller = new AbortController();

    const { runs } = await driveTurn(
      defineHarness({
        name: "reported",
        async *run() {
          yield { type: "error", message: "the model refused", code: "model" };
          controller.abort();
        },
      }),
      controller.signal,
    );

    expect((runs[0]!.detail as { error?: { message?: string } }).error?.message).toBe("the model refused");
  });
});
