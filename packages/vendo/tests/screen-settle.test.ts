/**
 * THE SETTLE — the second reason a screen can end, beside `SCREEN_STEPS`.
 *
 * A seam test like its neighbour (`screen-agent.test.ts`): every case writes
 * through the real `WorkspaceFs` + `commit()` and the real render seam, because
 * "the seam painted it" is one of the two halves of a settle and a stubbed seam
 * could not disagree with this file. The MODEL is scripted, which is the point —
 * the loop is what is measured, and a script that keeps writing is the only way to
 * prove what ended the run.
 */
import { type AppId, type Json, type ToolDescriptor } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { SAVE_APP_TOOL, SCREEN_STEPS, screenAssembler } from "../src/screen-agent.js";
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

const APP = "app_settle" as AppId;

const GOOD_APP = `<App name="Spending">
  <Stack>
    <Text value="This month" />
  </Stack>
</App>`;

const OTHER_APP = `<App name="Spending">
  <Stack>
    <Text value="Last month" />
  </Stack>
</App>`;

/** `validate`'s real answer shape (`vendo-verbs.ts` — `{ ok, findings }`). */
const verdict = (ok: boolean): Json =>
  ({ ok, findings: ok ? [] : [{ severity: "block", message: "that tool has no such field" }] });

function harness(options: { turns: Parameters<typeof scriptedModel>[0]; ok?: boolean }) {
  const guard = testGuard();
  const descriptors: ToolDescriptor[] = [readTool("validate", "write")];
  const registry = boundRegistry(
    Object.fromEntries(descriptors.map((descriptor) => [
      descriptor.name,
      { descriptor, execute: (): Json => verdict(options.ok ?? true) },
    ])),
    guard,
  );
  const workspace = testWorkspace();
  const model = scriptedModel(options.turns);
  const assembler = screenAssembler({
    models: seats(model),
    tools: registry,
    workspace: async () => workspace,
    // The app half is wired, so a commit that compiles actually PAINTS — without a
    // paint nothing is on screen and nothing can settle.
    render: () => ({ authoredApp: async () => ({ data: {} }) }),
  });
  return {
    model,
    invocations: registry.invocations,
    saved: async (): Promise<string | undefined> =>
      await workspace.readFile(`/user/apps/${APP}/app.vendo`).catch(() => undefined),
    assemble: async () => await assembler.assemble({ appId: APP, request: "show me my spending" }, ctx()),
  };
}

const saveApp = (content: string) => toolCallTurn(SAVE_APP_TOOL, { content });
const validate = (args: unknown) => toolCallTurn("validate", args, "call_v");

describe("the settle — the last paint after which nothing changed", () => {
  it("ends the run when validate clears the screen that painted, budget left or not", async () => {
    // A model that never stops: without a settle it spends every step, which is
    // what `screen-agent.test.ts`'s budget case pins. Here step 2 clears the
    // painted screen, so step 3 never happens and its rewrite never lands.
    const screen = harness({
      turns: [
        saveApp(GOOD_APP),
        validate({ appId: APP }),
        ...Array.from({ length: SCREEN_STEPS }, () => saveApp(OTHER_APP)),
      ],
    });
    const outcome = await screen.assemble();

    expect(outcome.kind).toBe("assembled");
    expect(screen.model.calls).toBe(2);
    expect(await screen.saved()).toBe(GOOD_APP);
  });

  it("spends no second review on a screen the loop already had reviewed clean", async () => {
    // `validate({ appId })` IS the mandatory pass's own second call — same door,
    // same row, same reviewer, same query evidence. One verdict on these bytes is
    // one review.
    const screen = harness({ turns: [saveApp(GOOD_APP), validate({ appId: APP })] });
    await screen.assemble();

    expect(screen.invocations["validate"]).toBe(1);
  });

  it("does not settle on a verdict about text that is not the screen", async () => {
    // The skill teaches validating a document BEFORE saving it. A pass on a draft
    // says nothing about what the person is looking at, so the run goes on.
    const screen = harness({
      turns: [saveApp(GOOD_APP), validate({ document: OTHER_APP }), saveApp(OTHER_APP), textTurn("done")],
    });
    await screen.assemble();

    expect(screen.model.calls).toBe(4);
    expect(await screen.saved()).toBe(OTHER_APP);
  });

  it("does not settle on findings — a dirty verdict is a reason to keep working", async () => {
    // Dirty means the mandatory pass also finds something, so this run ends with a
    // repair round — hence the spare turns and a floor rather than an exact count.
    const screen = harness({
      ok: false,
      turns: [
        saveApp(GOOD_APP),
        validate({ appId: APP }),
        saveApp(OTHER_APP),
        textTurn("done"),
        saveApp(OTHER_APP),
        textTurn("done"),
      ],
    });
    await screen.assemble();

    expect(screen.model.calls).toBeGreaterThan(2);
    expect(await screen.saved()).toBe(OTHER_APP);
  });
});
