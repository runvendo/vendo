/**
 * PROSE IS NOT A SCREEN — the loop's refusal to end with words and no document.
 *
 * A SEAM test like `screen-agent.test.ts` beside it: the real `WorkspaceFs` commit
 * path, the real render seam, and only the model scripted — because the model's
 * choice of CHANNEL is the thing under test. Measured on 2026-08-10, 3 of 45 vendo
 * screen runs read one host tool and then wrote the answer in words: no `save_app`,
 * no paint, and a failure nobody could act on.
 *
 * The two cases that must NOT change are here too: one nudge and no more, and a
 * question through `ask_user`, which is an honest non-document end.
 */
import { ASK_USER_TOOL, type AppId, type Json, type ToolDescriptor, type VendoViewPart } from "@vendoai/core";
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

const APP = "app_prose" as AppId;
const ASK = "what are my three smallest spending categories?";

/** The smallest document the seam will paint (see `screen-agent.test.ts`). */
const GOOD_APP = `<App name="Spending">
  <Stack>
    <Text value="This month" />
  </Stack>
</App>`;

const spendSummary: ToolDescriptor = { ...readTool("maple_spend_summary"), title: "Spending summary" };
const validate: ToolDescriptor = { ...readTool("validate", "write") };

function harness(
  turns: Array<Parameters<typeof scriptedModel>[0][number]>,
  tools: ToolDescriptor[] = [spendSummary, validate],
) {
  const registry = boundRegistry(
    Object.fromEntries(tools.map((tool) => [tool.name, { descriptor: tool, execute: (): Json => ({ ok: true }) }])),
    testGuard(),
  );
  const workspace = testWorkspace();
  const emitted: VendoViewPart[] = [];
  const model = scriptedModel(turns);
  const assembler = screenAssembler({
    models: seats(model),
    tools: registry,
    workspace: async () => workspace,
    render: () => ({
      facts: () => ({ tools: tools.map((tool) => tool.name), components: ["Stat", "Text"] }),
      authoredApp: async () => ({ data: {} }),
    }),
  });
  return {
    model,
    emitted,
    workspace,
    assemble: async () => await assembler.assemble(
      { appId: APP, request: ASK, onView: (part) => emitted.push(part) },
      ctx(),
    ),
  };
}

const saveApp = (content: string) => toolCallTurn(SAVE_APP_TOOL, { content });

describe("a drive that ends in prose has not finished", () => {
  it("is told the channel and lands the document on the next round", async () => {
    const screen = harness([
      // The measured failure: an answer, in words, to a request for a screen.
      textTurn("Your three smallest are laundry ($6.15), parking ($19.40) and pharmacy ($48.72)."),
      saveApp(GOOD_APP),
      textTurn("done"),
    ]);
    const result = await screen.assemble();

    expect(result.kind).toBe("assembled");
    // The real write path and the real paint, not a claim about them.
    expect(await screen.workspace.readFile(`/user/apps/${APP}/app.vendo`)).toBe(GOOD_APP);
    expect(screen.emitted.map((part) => part.appId)).toContain(APP);

    // The second prompt carries the nudge AND the original ask — a drive starts
    // from the messages it is given, so a nudge without the ask is a rewrite.
    const nudged = JSON.stringify(screen.model.prompts[1] ?? "");
    expect(nudged).toContain("Words typed in this turn reach nobody");
    expect(nudged).toContain("three smallest spending categories");
  });

  it("gets ONE round — a second answer in words is the honest failure, not a third prompt", async () => {
    const screen = harness([textTurn("here is the answer"), textTurn("here it is again")]);
    const result = await screen.assemble();

    expect(result).toEqual({ kind: "unavailable", why: "assembly produced nothing that renders" });
    // Two drives, and the scripted model would THROW on a third — so this is also
    // the proof that nothing loops here.
    expect(screen.model.calls).toBe(2);
  });

  it("leaves a question through the one door alone — asking is not stalling", async () => {
    const screen = harness(
      [toolCallTurn(ASK_USER_TOOL, { question: "which month?" }, "call_ask")],
      [spendSummary, validate, readTool(ASK_USER_TOOL)],
    );
    await screen.assemble();

    // `askedUserStop` ended the drive on the question, and the run is WAITING for a
    // person: one model call, and nothing telling it to save instead.
    expect(screen.model.calls).toBe(1);
    expect(JSON.stringify(screen.model.prompts)).not.toContain("Words typed in this turn reach nobody");
  });
});
