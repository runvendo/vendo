/**
 * The screen agent's PROGRESS budget (`SCREEN_IDLE_STEPS`).
 *
 * A seam test for the same reason `screen-agent.test.ts` is one: the thing under
 * test is whether a stop condition this package declares reaches the loop
 * `@vendoai/harnesses` enforces, so every case drives the real `screenAssembler`
 * over the real workspace and the real render seam. Only the MODEL is a double —
 * the loop is what is being measured, and a model that never stops is the only way
 * to measure a budget.
 */
import { type AppId, type Json, type ToolDescriptor } from "@vendoai/core";
import { describe, expect, it, vi } from "vitest";
import {
  SAVE_APP_TOOL,
  SCREEN_IDLE_STEPS,
  SCREEN_STEPS,
  screenAssembler,
} from "../src/screen-agent.js";
import {
  boundRegistry,
  ctx,
  readTool,
  scriptedModel,
  seats,
  testGuard,
  testWorkspace,
  toolCallTurn,
} from "../src/agent-doubles.test-util.js";

const APP = "app_budget" as AppId;

/** Renders: one node under the root is the seam's whole gate, so this is the
 *  smallest document that can legitimately paint. */
const GOOD_APP = `<App name="Spending">
  <Stack>
    <Text value="This month" />
  </Stack>
</App>`;

/** Lands as bytes and never paints — so the run has no screen, and the budget must
 *  stay flat. */
const BROKEN_APP = `not a document at all`;

const DESCRIPTORS: ToolDescriptor[] = [
  readTool("maple_spend_summary"),
  { ...readTool("validate", "write") },
  { ...readTool("search_components", "write") },
];

function harness(turns: Array<Parameters<typeof scriptedModel>[0][number]>) {
  const registry = boundRegistry(
    Object.fromEntries(DESCRIPTORS.map((descriptor) => [
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
      facts: () => ({ tools: DESCRIPTORS.map((descriptor) => descriptor.name), components: ["Stat", "Text"] }),
      authoredApp: async () => ({ data: {} }),
    }),
  });
  return {
    model,
    assemble: async () => await assembler.assemble({ appId: APP, request: "show me my spending" }, ctx()),
  };
}

const saveApp = (content: string) => toolCallTurn(SAVE_APP_TOOL, { content });
const validate = () => toolCallTurn("validate", { appId: APP });
const search = () => toolCallTurn("search_components", { query: "chart" });

describe("the progress budget (SCREEN_IDLE_STEPS)", () => {
  it("ends the drive after two steps that put nothing new on the screen", async () => {
    // Save once — the screen is up — then never save again. The cap would have paid
    // for all ten of these; the budget answers to progress instead.
    const screen = harness([saveApp(GOOD_APP), validate(), search(), search(), search(), search()]);
    await screen.assemble();
    expect(screen.model.calls).toBe(1 + SCREEN_IDLE_STEPS);
  });

  it("a save that reaches the screen buys the next steps back", async () => {
    // The shipped cycle — validate, fix what it named, save again — must survive,
    // so the idle count is CONSECUTIVE steps and a landed save resets it.
    const screen = harness([
      saveApp(GOOD_APP),
      validate(),
      saveApp(GOOD_APP.replace("This month", "Last month")),
      validate(),
      search(),
      search(),
    ]);
    await screen.assemble();
    expect(screen.model.calls).toBe(5);
  });

  it("leaves the budget FLAT until something is on screen — no truncated screens", async () => {
    // Bytes that land and never paint. Nothing to see, so nothing to stop early:
    // the only bound is the cap, exactly as before this budget existed.
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const screen = harness([
      saveApp(BROKEN_APP),
      ...Array.from({ length: SCREEN_STEPS }, () => search()),
    ]);
    await screen.assemble();
    expect(screen.model.calls).toBe(SCREEN_STEPS);
  });
});
