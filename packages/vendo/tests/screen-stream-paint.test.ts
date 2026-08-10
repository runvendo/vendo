/**
 * THE DOCUMENT PAINTS WHILE IT IS STILL BEING DICTATED.
 *
 * A screen is not slow to build, it is slow to be handed over: the whole document
 * is one `save_app` argument, so before this the person saw nothing until its last
 * character arrived — 30s to 90s of silence in the benchmark's own stage marks
 * between the step that began the save and the save landing.
 *
 * A SEAM test, like `screen-agent.test.ts` beside it: the prefix goes through the
 * real staging + `commit()` path and comes back through the real render seam
 * (`wrapWorkspaceForRender` → `viewForWrite` → `compileWire`), because the claim
 * being tested is that the compiler and the seam already accept a prefix. Only the
 * model is a double, and it streams its tool arguments the way a provider does
 * (`tool-input-delta`), which is the input the whole feature reads.
 *
 * The ones that must be able to fail: drop `onInputDelta` from the `save_app` hand
 * (`packages/vendo/src/screen-agent.ts`) or from the closed loadout's `tool()`
 * (`packages/harnesses/src/vendo/vendo.ts`) and the first case goes red — nothing
 * paints until the call is complete, which is the behaviour this replaces.
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
  ZERO_USAGE,
  type StreamPart,
  type TestWorkspace,
} from "../src/agent-doubles.test-util.js";

const APP = "app_stream_paint" as AppId;

/** Long enough to cross the painter's window more than once, and one node per
 *  line so a prefix cut at a line boundary is always a document that renders. */
const ROWS = 60;
const LONG_APP = `<App name="Spending">
  <Stack>
${Array.from({ length: ROWS }, (_, index) => `    <Text value="row ${index} ${"detail ".repeat(6)}" />`).join("\n")}
  </Stack>
</App>`;

/** One tool call whose arguments ARRIVE, in provider chunks, before the call
 *  itself does — which is the only difference from `toolCallTurn`. */
function streamedToolCall(toolName: string, input: unknown, chunkChars = 120): StreamPart[] {
  const text = JSON.stringify(input);
  const deltas: StreamPart[] = [];
  for (let at = 0; at < text.length; at += chunkChars) {
    deltas.push({ type: "tool-input-delta", id: "call_1", delta: text.slice(at, at + chunkChars) });
  }
  return [
    { type: "tool-input-start", id: "call_1", toolName },
    ...deltas,
    { type: "tool-input-end", id: "call_1" },
    { type: "tool-call", toolCallId: "call_1", toolName, input: text },
    { type: "finish", usage: ZERO_USAGE, finishReason: { unified: "tool-calls", raw: undefined } },
  ];
}

const validate: ToolDescriptor = { ...readTool("validate", "write") };

function harness(turns: StreamPart[][]): {
  assemble: (request: string) => Promise<{ kind: string }>;
  emitted: VendoViewPart[];
  workspace: TestWorkspace;
} {
  const descriptors = [validate];
  const registry = boundRegistry(
    Object.fromEntries(descriptors.map((descriptor) => [
      descriptor.name,
      { descriptor, execute: (): Json => ({ ok: true }) },
    ])),
    testGuard(),
  );
  const workspace = testWorkspace();
  const emitted: VendoViewPart[] = [];
  const assembler = screenAssembler({
    models: seats(scriptedModel(turns)),
    tools: registry,
    workspace: async () => workspace,
    // The app half is wired, because a wired app half is what makes the seam emit
    // its skeleton first and settle second — the shape a real deployment has.
    render: () => ({ authoredApp: async () => ({ data: {} }) }),
  });
  return {
    emitted,
    workspace,
    assemble: async (request: string) => await assembler.assemble(
      { appId: APP, request, onView: (part) => emitted.push(part) },
      ctx(),
    ),
  };
}

const appSaves = (workspace: TestWorkspace): number =>
  workspace.commits.filter((commit) => commit.message?.startsWith("app.vendo") === true).length;

describe("painting the document as it arrives", () => {
  it("puts a PREFIX of the document on screen before the save_app call is complete", async () => {
    const screen = harness([streamedToolCall(SAVE_APP_TOOL, { content: LONG_APP }), textTurn("done")]);
    const outcome = await screen.assemble("show me my spending");

    expect(outcome.kind).toBe("assembled");
    // One save_app call, several commits: the extra ones can only have come from
    // the painter, because the loop's own hand writes exactly once per call.
    expect(appSaves(screen.workspace)).toBeGreaterThan(1);

    const painted = screen.emitted.map((part) => JSON.stringify(part.payload));
    // The first thing the person saw is a document that had not finished
    // arriving: it draws real rows, and it does not draw the last one.
    expect(painted[0]).toContain("row 0");
    expect(painted[0]).not.toContain(`row ${ROWS - 1}`);
    // And the screen they are left with is the whole document.
    expect(painted.at(-1)).toContain(`row ${ROWS - 1}`);
  });

  it("leaves the completed document as the last word, so a prefix is never the delivered screen", async () => {
    const screen = harness([streamedToolCall(SAVE_APP_TOOL, { content: LONG_APP }), textTurn("done")]);
    await screen.assemble("show me my spending");

    // Every prefix is strictly shorter than the document and ends at a line
    // boundary, so the completed save always has bytes left to change — a commit
    // that changed nothing would paint nothing and read as a save that never
    // reached the screen.
    const landed = await screen.workspace.readFile(`/user/apps/${APP}/app.vendo`);
    expect(landed).toBe(LONG_APP);
    expect(screen.emitted.at(-1)?.payload.streaming).not.toBe(true);
  });
});
