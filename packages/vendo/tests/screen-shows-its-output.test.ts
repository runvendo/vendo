/**
 * The writer sees its own output — `save_app` answers with what the screen it just
 * painted is SHOWING.
 *
 * THE HOLE THIS CLOSES. The seam runs this document's queries on every save (the
 * `authoredApp` half) and hands the answers to the person's screen; the loop that
 * wrote the document never saw one of them. So it wrote blind — measured over the
 * screen runs on disk, 26 of 34 saved their whole first document without reading a
 * single row — and the only reader of the real values was a reviewer model asked to
 * do the arithmetic in its head. That is how a $3,626,515 net worth painted as
 * $362.65 with every mechanical check green.
 *
 * A SEAM test, not a loop test: the resolved data travels the real
 * `wrapWorkspaceForRender` → `viewForWrite` → `shownIn` path into the real hand,
 * and the assertion reads it off what the MODEL was sent on its next call. Nothing
 * between the producer and the consumer is stubbed, so the two cannot agree with
 * each other while disagreeing with the product. What is a double is the same pair
 * the neighbouring suite doubles: the model (scripted chunks) and the app half
 * (`AppsRuntime.authored`, which needs a store).
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

const APP = "app_screen_output" as AppId;

/** One node under the root is the seam's whole paint gate (`renders`). */
const GOOD_APP = `<App name="Balances">
  <Stack>
    <Text value="Net worth" />
  </Stack>
</App>`;

const descriptors: ToolDescriptor[] = [readTool("list_accounts"), readTool("validate", "write")];

/** The assembler over a real workspace, the real render seam, and an app half that
 *  answers exactly what a host's queries would. */
function harness(options: {
  /** What the app half resolved — `undefined` leaves the half UNWIRED, which is
   *  "nothing known" rather than "no data". */
  data?: Record<string, Json>;
  dataUnavailable?: true;
}) {
  const guard = testGuard();
  const registry = boundRegistry(
    Object.fromEntries(descriptors.map((descriptor) => [
      descriptor.name,
      { descriptor, execute: (): Json => ({ ok: true }) },
    ])),
    guard,
  );
  const workspace = testWorkspace();
  const model = scriptedModel([toolCallTurn(SAVE_APP_TOOL, { content: GOOD_APP }), textTurn("done")]);
  const assembler = screenAssembler({
    models: seats(model),
    tools: registry,
    workspace: async () => workspace,
    render: () => (options.data === undefined ? {} : {
      authoredApp: async () => ({
        data: options.data ?? {},
        ...(options.dataUnavailable === undefined ? {} : { dataUnavailable: true as const }),
      }),
    }),
  });
  return {
    model,
    assemble: async () => await assembler.assemble({ appId: APP, request: "what am I worth" }, ctx()),
  };
}

/** Everything the model was sent on the call AFTER it saved — where a tool result
 *  lands. */
const secondCall = (model: ReturnType<typeof scriptedModel>): string =>
  JSON.stringify(model.prompts[1] ?? "");

describe("save_app answers with what the screen is showing", () => {
  it("hands back the real query results the paint resolved, by the writer's own query names", async () => {
    const screen = harness({ data: { list_accounts: { data: [{ name: "Everyday", balance: 195000 }] } } });
    await screen.assemble();

    const sent = secondCall(screen.model);
    // The query's own name, so the writer can line the answer up with its bindings…
    expect(sent).toContain("list_accounts");
    // …and the MAGNITUDE, which is the whole point: a cents field bound into a
    // dollar formatter is off by a hundred, and this is the only place the loop can
    // see that before the person does.
    expect(sent).toContain("195000");
  });

  it("says plainly when a screen resolved no data at all — every value on it was typed", async () => {
    const screen = harness({ data: {} });
    await screen.assemble();
    expect(secondCall(screen.model)).toContain("resolved NO query data");
  });

  it("names a FAILED query, because every value bound to it renders \"—\"", async () => {
    const screen = harness({ data: {}, dataUnavailable: true });
    await screen.assemble();
    const sent = secondCall(screen.model);
    expect(sent).toContain("came back");
    expect(sent).not.toContain("resolved NO query data");
  });

  it("claims nothing when no app half ran, exactly as the paint verdict claims nothing", async () => {
    const screen = harness({});
    await screen.assemble();
    const sent = secondCall(screen.model);
    // The save still landed and the hand still says so…
    expect(sent).toContain("Run validate on it now.");
    // …but an unwired half resolved no query, so there is nothing to report and the
    // hand must not read that as an empty screen.
    expect(sent).not.toContain("resolved NO query data");
    expect(sent).not.toContain("This is what your screen is showing");
  });
});
