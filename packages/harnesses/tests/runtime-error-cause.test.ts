/**
 * "The real error goes to the operator's terminal" — which it did not, for the
 * one failure that needs it most. A dead connection reaches this seam as undici's
 * bare `TypeError: fetch failed`, whose entire message is those three words; the
 * reason lives on the cause, and the log kept only the message. An operator got
 * "fetch failed" and no way to tell a refused connect from a dropped socket.
 */
import { setLogger, type ThreadId, type VendoLogEvent } from "@vendoai/core";
import { afterEach, expect, test } from "vitest";
import { defineHarness } from "../src/define.js";
import { memoryHarnessStateStore } from "../src/harness-state.js";
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

afterEach(() => {
  setLogger(undefined);
});

test("the operator's line names the cause under a bare transport failure", async () => {
  const lines: VendoLogEvent[] = [];
  setLogger((event) => lines.push(event));
  const guard = testGuard();
  const runtime = createHarnessRuntime({
    tools: boundRegistry({}, guard),
    guard,
    skills: testSkills([]),
    transcript: testTranscript(),
    harnessState: memoryHarnessStateStore(),
  });
  const harness = defineHarness({
    name: "dead-socket",
    async *run() {
      yield { type: "text", delta: "starting" };
      throw Object.assign(new TypeError("fetch failed"), { cause: new Error("ECONNRESET") });
    },
  });

  await readSse(await runtime.run({
    harness,
    threadId: "thr_1" as ThreadId,
    messages: [userMessage("m1", "hello")],
    ctx: ctx(),
    workspace: testWorkspace(),
    models: unusedModels(),
    interactive: true,
  }));

  const failure = lines.find((line) => line.code === "harnesses.runtime-run-failed");
  expect(failure?.data?.["detail"]).toMatchObject({
    error: "fetch failed",
    cause: "Error: ECONNRESET",
  });
});
