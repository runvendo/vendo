/**
 * WHAT ENDS AN ASSEMBLY — the completion signal, at the seam.
 *
 * A step cap is a hang detector, not a finish line, and until the `done` flag on
 * `save_app` the cap was the only thing that ended a screen: measured on genbench
 * 2026-08-10 the median screen was on the person's display at 35.8s and the run
 * settled at 137.3s, spending everything it had left on an answer that was already
 * up. So these cases are about the LOOP stopping, and they measure it the only way
 * that cannot lie about it — the number of times the model was asked for another
 * step.
 *
 * SEAM, not a loop test: every case writes through the real `commit()` and reads
 * back through the real render seam, because the signal is an AND of the model's
 * claim and the seam's paint and a stub on either side could not disagree.
 */
import { type AppId, type Json, type ToolDescriptor, type VendoViewPart } from "@vendoai/core";
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

const APP = "app_stop" as AppId;

/** The smallest document the seam will paint (one node under the root). */
const GOOD_APP = `<App name="Spending">
  <Stack>
    <Text value="This month" />
  </Stack>
</App>`;

/** Unparseable, so the seam paints nothing at all. */
const BROKEN_APP = `not a document at all`;

const GOOD_PLAN = `<Plan name="Spending">
  <Group title="Overview">
    <Leaf component="Stat" />
  </Group>
</Plan>`;

const descriptors: ToolDescriptor[] = [
  readTool("maple_spend_summary"),
  readTool("validate", "write"),
  readTool("search_components", "write"),
];

interface Harness {
  model: ScriptedModel;
  emitted: VendoViewPart[];
  assemble(): Promise<{ kind: string }>;
}

function harness(turns: Array<Parameters<typeof scriptedModel>[0][number]>): Harness {
  const registry = boundRegistry(
    Object.fromEntries(descriptors.map((descriptor) => [
      descriptor.name,
      // `validate` answers clean, so the mandatory reviewer pass adds no round and
      // what these cases count is the assembly drive itself.
      { descriptor, execute: (): Json => ({ ok: true }) },
    ])),
    testGuard(),
  );
  const workspace = testWorkspace();
  const model = scriptedModel(turns);
  const emitted: VendoViewPart[] = [];
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
    emitted,
    assemble: async () => await assembler.assemble(
      { appId: APP, request: "show me my spending", onView: (part) => emitted.push(part) },
      ctx(),
    ),
  };
}

const save = (content: string, done?: boolean, id = "call_1") =>
  toolCallTurn(SAVE_APP_TOOL, { content, ...(done === undefined ? {} : { done }) }, id);

describe("a finished screen ends the run", () => {
  it("stops on the save the model marked done", async () => {
    const screen = harness([
      save(GOOD_APP, true),
      // The wandering this signal exists to cut. Reaching either of these means the
      // loop is still spending its budget over a screen it called finished.
      toolCallTurn("search_components", { query: "chart" }, "call_2"),
      textTurn("done"),
    ]);
    const result = await screen.assemble();
    expect(result.kind).toBe("assembled");
    expect(screen.model.calls).toBe(1);
    expect(screen.emitted.length).toBeGreaterThan(0);
  });

  it("keeps going on a save that is NOT marked done — saving as you go is not finishing", async () => {
    // The control for the case above: the same painted save without the claim, and
    // the loop rightly asks for another step. A stop that fired on any painted save
    // would end half the screens in this codebase one node in.
    const screen = harness([save(GOOD_APP), textTurn("done")]);
    const result = await screen.assemble();
    expect(result.kind).toBe("assembled");
    expect(screen.model.calls).toBe(2);
  });

  it("does not stop on a done the seam refused to paint — the claim is ANDed with the paint", async () => {
    const screen = harness([
      save(BROKEN_APP, true),
      save(GOOD_APP, true, "call_2"),
    ]);
    const result = await screen.assemble();
    // The first claim bought nothing: no paint, so the loop heard why and carried
    // on. The second one is a finished screen and ends it.
    expect(screen.model.calls).toBe(2);
    expect(result.kind).toBe("assembled");
    expect(screen.emitted.length).toBeGreaterThan(0);
  });
});

describe("the door out ends the run too", () => {
  it("escalate ends the turn, which its own description already promised", async () => {
    const screen = harness([
      toolCallTurn(ESCALATE_TOOL, { plan: GOOD_PLAN, why: "this needs its own server" }, "call_esc"),
      textTurn("nobody should read this"),
    ]);
    const result = await screen.assemble();
    expect(result).toEqual({ kind: "escalate", why: "this needs its own server" });
    expect(screen.model.calls).toBe(1);
  });
});
