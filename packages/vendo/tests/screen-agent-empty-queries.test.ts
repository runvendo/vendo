/**
 * An empty result reaches the WRITER, not just the screen.
 *
 * A tool listing declares field names and never says whether anything is there,
 * and the shipped skill tells the writer to read the shape off the listing — so a
 * query that comes back with no rows was invisible to the loop that had to draw
 * it. It drew a table of rows that do not exist and a control that acts on one of
 * them, which fires with an empty argument (live: "Cancel transfer" over zero
 * pending transfers).
 *
 * SEAM tests, like `screen-agent.test.ts`: the save goes through the real
 * `WorkspaceFs` commit and the real render seam, the app half really resolves the
 * queries, and what is asserted is the text the MODEL received back — not a return
 * value this file arranged. The doubles are the model (scripted) and the store
 * behind the app half, exactly as they are there.
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

const APP = "app_screen_empty" as AppId;

const GOOD_APP = `<App name="Transfers">
  <Stack>
    <Text value="Pending transfers" />
  </Stack>
</App>`;

const transfersList: ToolDescriptor = {
  ...readTool("maple_transfers_list"),
  title: "Pending transfers",
  outputSchema: { type: "object", properties: { data: { type: "array" } } },
};
const validate: ToolDescriptor = { ...readTool("validate", "write") };

/** One assembler over a REAL workspace and the REAL render seam, with the app half
 *  answering whatever this case's queries resolved to. */
function harness(resolved: { data: Record<string, Json>; dataUnavailable?: true }) {
  const descriptors = [transfersList, validate];
  const registry = boundRegistry(
    Object.fromEntries(descriptors.map((descriptor) => [
      descriptor.name,
      { descriptor, execute: (): Json => ({ ok: true }) },
    ])),
    testGuard(),
  );
  const workspace = testWorkspace();
  const model = scriptedModel([toolCallTurn(SAVE_APP_TOOL, { content: GOOD_APP }), textTurn("done")]);
  const assembler = screenAssembler({
    models: seats(model),
    tools: registry,
    workspace: async () => workspace,
    render: () => ({ authoredApp: async () => resolved }),
  });
  return {
    model,
    assemble: async () => await assembler.assemble({ appId: APP, request: "my pending transfers" }, ctx()),
  };
}

/** Everything the model was sent on the turn AFTER the save — where the save's own
 *  answer lands. */
const afterTheSave = (prompts: readonly unknown[]): string => JSON.stringify(prompts[1] ?? "");

describe("a query that came back with no rows", () => {
  it("is named back to the writer, with the rule that a control over no rows is broken", async () => {
    const screen = harness({ data: { transfers: { data: [] } } });
    expect((await screen.assemble()).kind).toBe("assembled");

    const heard = afterTheSave(screen.model.prompts);
    expect(heard).toContain("NO ROWS");
    // The query BY NAME, as the writer declared it — a rule it cannot act on
    // without knowing which one is a rule it will not act on.
    expect(heard).toContain("transfers");
    // The half that was shipping broken rather than merely empty.
    expect(heard).toContain("control");
  });

  it("counts a wrapper object whose every list is empty, and nothing else", async () => {
    // `{ data: [], next: null }` is how a host list tool answers with nothing;
    // `balance_cents: 0` is a record, and zero is real data.
    const screen = harness({ data: { transfers: { data: [], next: null }, account: { balance_cents: 0 } } });
    await screen.assemble();

    // The list ends after `transfers`, so the record query is not in it.
    expect(afterTheSave(screen.model.prompts)).toContain("NO ROWS: transfers.");
  });

  it("says nothing when the rows are there", async () => {
    const screen = harness({ data: { transfers: { data: [{ id: "tr_1" }] } } });
    await screen.assemble();

    const heard = afterTheSave(screen.model.prompts);
    expect(heard).not.toContain("NO ROWS");
    expect(heard).toContain("Run validate on it now");
  });

  it("says nothing when the load FAILED — absent data is not empty data", async () => {
    // A query the guard refused or the host errored is missing from the resolved
    // data and carries its own marker. Telling the writer "there are none" would
    // put an empty state over data that exists and merely did not arrive.
    const screen = harness({ data: { transfers: { data: [] } }, dataUnavailable: true });
    await screen.assemble();

    expect(afterTheSave(screen.model.prompts)).not.toContain("NO ROWS");
  });
});
