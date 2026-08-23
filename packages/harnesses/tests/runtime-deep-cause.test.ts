/**
 * The cause the operator needs is at the BOTTOM of the chain, not one hop down.
 *
 * A dead socket on the workspace seam arrives wrapped twice: `box.ts` names the
 * route it died on, `cloudSandbox` names the console it could not reach, and
 * undici's `fetch failed` sits on top of the one word — ECONNREFUSED, ECONNRESET —
 * that tells a refused connect from a dropped socket. Printing one hop down printed
 * a wrapper, which is the same three words the log already had.
 */
import { VendoError, setLogger, type ThreadId, type VendoLogEvent } from "@vendoai/core";
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

test("the operator's line names the ROOT cause, not the wrapper above it", async () => {
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
    name: "wrapped-socket",
    async *run() {
      yield { type: "text", delta: "starting" };
      // Exactly the chain the workspace seam builds: the box's route, the
      // adapter's sentence, undici's three words, the reason.
      throw new VendoError("sandbox-unavailable", "box /session/workspace could not be reached", {
        path: "/session/workspace",
        cause: new VendoError("sandbox-unavailable", "Vendo Cloud sandbox could not be reached", {
          path: "/request",
          cause: Object.assign(new TypeError("fetch failed"), { cause: new Error("ECONNREFUSED") }),
        }),
      });
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
  expect(failure?.data?.["detail"]).toMatchObject({ cause: "Error: ECONNREFUSED" });
});
