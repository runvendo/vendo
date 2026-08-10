/**
 * THE RECON SEAT — the screen agent's steps that are not writing the document.
 *
 * A seam test in the same sense as `screen-agent.test.ts`: it drives the real
 * `screenAssembler` over the real workspace and render seam, and doubles only the
 * two MODELS — which is the whole point here, because the thing under test is
 * WHICH model served which step. Two scripted models cannot lie about that: each
 * one records its own calls and the tool list it was handed.
 */
import type { AppId, Json, ToolDescriptor } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { ESCALATE_TOOL, SAVE_APP_TOOL, screenAssembler } from "../src/screen-agent.js";
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
  type ScriptedModel,
} from "../src/agent-doubles.test-util.js";

const APP = "app_recon" as AppId;

const GOOD_APP = `<App name="Spending">
  <Stack>
    <Text value="This month" />
  </Stack>
</App>`;

const descriptors: ToolDescriptor[] = [
  readTool("maple_spend_summary"),
  readTool("validate", "write"),
  readTool("search_components", "write"),
];

/** One assembler whose `default` and `fill` seats are DIFFERENT scripted models,
 *  which is the only condition under which the recon phase exists at all. */
function harness(models: { default: ScriptedModel; fill?: ScriptedModel }) {
  const registry = boundRegistry(
    Object.fromEntries(descriptors.map((descriptor) => [
      descriptor.name,
      { descriptor, execute: (): Json => ({ ok: true }) },
    ])),
    testGuard(),
  );
  const workspace = testWorkspace();
  const assembler = screenAssembler({
    models: { ...seats(models.default), ...(models.fill === undefined ? {} : { fill: models.fill }) },
    tools: registry,
    workspace: async () => workspace,
    render: () => ({
      facts: () => ({ tools: descriptors.map((descriptor) => descriptor.name), components: ["Stat", "Text"] }),
      authoredApp: async () => ({ data: {} }),
    }),
  });
  return async () => await assembler.assemble({ appId: APP, request: "show me my spending" }, ctx());
}

describe("the recon seat", () => {
  it("serves the FIRST step on `fill`, with the writing hands withheld", async () => {
    // The cheap seat reads the catalog and stops. It could not have saved even if
    // it wanted to — that is the assertion below, not a hope about the script.
    const fill = scriptedModel([toolCallTurn("search_components", { query: "stat" })]);
    const strong = scriptedModel([toolCallTurn(SAVE_APP_TOOL, { content: GOOD_APP }), textTurn("done")]);
    const result = await harness({ default: strong, fill })();

    expect(result.kind).toBe("assembled");
    // One step on the cheap seat, and the read is what ended the phase.
    expect(fill.calls).toBe(1);
    const recon = fill.toolNamesPerCall[0] ?? [];
    expect(recon).toContain("search_components");
    expect(recon).toContain("validate");
    // The two hands that write. Withheld means ABSENT from the request, so there
    // is no version of this step that produces a document or an escalation plan.
    expect(recon).not.toContain(SAVE_APP_TOOL);
    expect(recon).not.toContain(ESCALATE_TOOL);
    // …and the strong seat got them back for the write, on the very next step.
    expect(strong.calls).toBeGreaterThanOrEqual(1);
    expect(strong.toolNamesPerCall[0] ?? []).toContain(SAVE_APP_TOOL);
  });

  it("does not exist when one model fills both seats", async () => {
    // A deployment with a single model must run the loop it ran before: no
    // withheld hand, no step spent reading first.
    const only = scriptedModel([toolCallTurn(SAVE_APP_TOOL, { content: GOOD_APP }), textTurn("done")]);
    const result = await harness({ default: only })();

    expect(result.kind).toBe("assembled");
    expect(only.toolNamesPerCall[0] ?? []).toContain(SAVE_APP_TOOL);
  });
});
