/**
 * A screen agent that answers in PROSE has not answered.
 *
 * `vendo()` ends a turn the moment the model stops calling tools, which is right
 * for the resident — its text IS the answer — and wrong for this specialist: the
 * drive drops every delta because nothing it writes reaches a person, so a run
 * that talks instead of saving delivers nothing at all. Measured on the screen
 * lane (2026-08-10): 4 of the 39 runs that were not cut off ended with one read
 * call, some prose, and no save, and each was reported as an assembly that
 * "produced nothing that renders".
 *
 * A seam test like `screen-agent.test.ts` beside it: the real workspace, the real
 * render seam, and the MODEL as the only double.
 */
import { type AppId, type Json, type ToolDescriptor, type VendoViewPart } from "@vendoai/core";
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

const GOOD_APP = `<App name="Spending">
  <Stack>
    <Text value="This month" />
  </Stack>
</App>`;

const spendSummary: ToolDescriptor = { ...readTool("maple_spend_summary"), title: "Spending summary" };
const askUser: ToolDescriptor = { ...readTool("ask_user"), title: "Ask the user" };

function harness(turns: Array<Parameters<typeof scriptedModel>[0][number]>) {
  const descriptors = [spendSummary, askUser];
  const registry = boundRegistry(
    Object.fromEntries(descriptors.map((descriptor) => [
      descriptor.name,
      { descriptor, execute: (): Json => ({ ok: true }) },
    ])),
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
      facts: () => ({ tools: descriptors.map((descriptor) => descriptor.name), components: ["Stat", "Text"] }),
      authoredApp: async () => ({ data: {} }),
    }),
  });
  return {
    emitted,
    model,
    assemble: async (request: string) => await assembler.assemble(
      { appId: APP, request, onView: (part) => emitted.push(part) },
      ctx(),
    ),
  };
}

describe("a saved document is the only way this loop can answer", () => {
  it("declines a bare text end-of-turn and hands the prose back to be saved", async () => {
    const screen = harness([
      // The failure, verbatim: a read call, then an answer written as chat.
      toolCallTurn("maple_spend_summary", {}, "call_read"),
      textTurn("You spent $4,231 this month, mostly on rent and groceries."),
      // What the loop's refusal buys — the same answer, as a document.
      toolCallTurn(SAVE_APP_TOOL, { content: GOOD_APP }, "call_save"),
      textTurn("done"),
    ]);
    const result = await screen.assemble("show me my spending");

    // The run that used to end here now ends with a painted screen.
    expect(result.kind).toBe("assembled");
    expect(screen.emitted.length).toBeGreaterThan(0);
    // And the prose rode back, so the second drive saves the answer it already
    // worked out rather than starting the ask over.
    const continued = JSON.stringify(screen.model.prompts.at(-1) ?? "");
    expect(continued).toContain("$4,231");
  });

  it("leaves a landed question alone — an ask is an honest end, not a stall", async () => {
    // Proved by EXHAUSTION: one turn is scripted and the model throws on a
    // second. `ask_user` is turn-ending by design, and pushing this run further
    // would make it guess the answer it just asked for.
    const screen = harness([toolCallTurn("ask_user", { question: "Which account?" }, "call_ask")]);
    const result = await screen.assemble("show me my spending");

    expect(screen.model.calls).toBe(1);
    expect(result.kind).toBe("unavailable");
  });
});
