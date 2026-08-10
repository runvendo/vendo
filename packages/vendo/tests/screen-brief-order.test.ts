/**
 * WHERE each part of the screen brief sits, read off the real system prompt.
 *
 * The brief is ~47,000 characters and cutting it is measured to cost quality, so
 * ORDER is the only lever left: the ask frames the reference at the top, the
 * syntax manual is the lookup table the model scans, and the last thing before
 * the ask is the quality bar plus this host's own theme and tool shapes. A
 * regression here is silent — every `toContain` assertion in the sibling brief
 * tests passes whatever the order — which is exactly why it is asserted by
 * position.
 */
import { type AppId, type Json, type ToolDescriptor } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { screenAssembler } from "../src/screen-agent.js";
import {
  boundRegistry,
  ctx,
  readTool,
  scriptedModel,
  seats,
  testGuard,
  testWorkspace,
  textTurn,
} from "../src/agent-doubles.test-util.js";

const APP = "app_order" as AppId;
const ASK = "show me where my spend is going";

const listTool: ToolDescriptor = { ...readTool("maple_spend_summary"), title: "Spending summary" };

/** One real assembler run — the brief is the bytes a model was handed, never a
 *  helper called by hand. */
async function brief(): Promise<string> {
  const model = scriptedModel([textTurn("nothing to build")]);
  const assembler = screenAssembler({
    models: seats(model),
    tools: boundRegistry(
      { [listTool.name]: { descriptor: listTool, execute: (): Json => ({ ok: true }) } },
      testGuard(),
    ),
    workspace: async () => testWorkspace(),
  });
  await assembler.assemble({ appId: APP, request: ASK }, ctx());
  return model.systemPrompts[0] ?? "";
}

describe("the screen brief's reading order", () => {
  it("leads with the ask and closes with the loop's own note", async () => {
    const system = await brief();

    expect(system.startsWith("# The ask")).toBe(true);
    expect(system).toContain(ASK);
    // The last `---`-joined section is this rung's environment note, so the
    // tool shapes are the final thing before the person's own message.
    expect(system.split("\n\n---\n\n").at(-1)?.startsWith("# In this loop")).toBe(true);
  });

  it("puts the syntax manual BEFORE the quality bar, not between it and the ask", async () => {
    const system = await brief();

    // The manual's own headings, the job description's quality bar, and the
    // host's theme slot — in the order the model reads them.
    const manual = system.indexOf("### `<Query id tool input/>`");
    const bar = system.indexOf("## What a good screen looks like");
    const loop = system.indexOf("# In this loop");
    expect(manual).toBeGreaterThan(0);
    expect(bar).toBeGreaterThan(manual);
    expect(loop).toBeGreaterThan(bar);

    // …and the bar is now in the back half rather than 31,000 characters of
    // grammar reference away from the ask (it used to sit at ~10% of the brief).
    expect(system.length - bar).toBeLessThan(system.length / 2);
  });
});
