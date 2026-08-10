/**
 * The finish rule — `screenFinishedStop` in `src/screen-agent.ts`.
 *
 * A screen the seam PAINTED and `validate` cleared is finished, and the drive ends
 * there. Before this, `SCREEN_STEPS` was the only thing that ever ended a screen,
 * so "done" was whatever the model happened to stop doing at step 10 (measured
 * 2026-08-10: median first paint 28.7s against a median settled 135.2s).
 *
 * Same seam posture as `screen-agent.test.ts` — the real `WorkspaceFs` commit path
 * and the real render seam, with the MODEL as the only double — and what it counts
 * is MODEL CALLS, because the whole rule is about the steps that are not spent.
 */
import { type AppId, type Json, type ToolDescriptor } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { SAVE_APP_TOOL, screenAssembler } from "../src/screen-agent.js";
import {
  boundRegistry,
  ctx,
  readTool,
  scriptedModel,
  seats,
  testGuard,
  testWorkspace,
  textTurn,
  toolCallTurn,
} from "../src/agent-doubles.test-util.js";

const APP = "app_finish" as AppId;

/** The smallest document the seam will actually paint (one node under the root). */
const GOOD_APP = `<App name="Spending">
  <Stack>
    <Text value="This month" />
  </Stack>
</App>`;

const saveApp = (content: string) => toolCallTurn(SAVE_APP_TOOL, { content });
/** Distinct call ids, so two scripted `validate` calls are two calls. */
const validateCall = (input: unknown, id: string) => toolCallTurn("validate", input, id);

function harness(turns: Array<Parameters<typeof scriptedModel>[0][number]>) {
  // Every tool here answers `{ ok: true }`, which for `validate` IS the clean
  // verdict the rule reads (`vendo-verbs.ts:131`).
  const descriptors: ToolDescriptor[] = [readTool("validate", "write")];
  const registry = boundRegistry(
    Object.fromEntries(descriptors.map((descriptor) => [
      descriptor.name,
      { descriptor, execute: (): Json => ({ ok: true }) },
    ])),
    testGuard(),
  );
  const workspace = testWorkspace();
  const model = scriptedModel(turns);
  const assembler = screenAssembler({
    models: seats(model),
    tools: registry,
    workspace: async () => workspace,
    render: () => ({
      facts: () => ({ tools: descriptors.map((descriptor) => descriptor.name), components: ["Stat", "Text"] }),
      authoredApp: async () => ({ data: {} }),
    }),
  });
  return {
    model,
    assemble: async () => await assembler.assemble({ appId: APP, request: "show me my spending" }, ctx()),
  };
}

describe("the finish rule (a painted save + a clean validate)", () => {
  it("ends the drive on the clean validate, without asking the model to volunteer it", async () => {
    // A third turn is scripted and must never be reached: the loop that used to
    // spend it is the ~100s a person waited after their screen was finished.
    const screen = harness([saveApp(GOOD_APP), validateCall({ appId: APP }, "call_v"), saveApp(GOOD_APP)]);
    const outcome = await screen.assemble();

    expect(outcome.kind).toBe("assembled");
    expect(screen.model.calls).toBe(2);
  });

  it("keeps going when a clean validate has no painted save behind it", async () => {
    // The pre-save `validate({document})` this loop's own brief invites, seen live
    // six seconds before the save that painted. Ending there would end the turn
    // with nothing on screen, so the paint half is not optional.
    const screen = harness([
      validateCall({ document: GOOD_APP }, "call_v"),
      saveApp(GOOD_APP),
      textTurn("done"),
    ]);
    const outcome = await screen.assemble();

    expect(outcome.kind).toBe("assembled");
    expect(screen.model.calls).toBe(3);
  });
});
