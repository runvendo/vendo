/**
 * What the screen agent is told about DESIGN.
 *
 * A seam test, like `screen-agent.test.ts` beside it: the brief is read off the
 * scripted model's own system prompt after a real `screenAssembler` run, so what
 * is measured is the text an assembly actually thinks with — never a helper
 * called by hand.
 *
 * Two halves, and they arrive by different routes on purpose. The design LAW is
 * shipped inside `buildingAppsSkill`, so both writers read the same words; the
 * host's THEME and design rules are configuration composition holds, so they
 * arrive through the `design` slot the way `system` does.
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
} from "../src/test-doubles.test-util.js";

const APP = "app_design" as AppId;

/** The host's own rules, as `apps.designRules` carries them, and a token value
 *  that appears nowhere else in the brief — so a passing assertion cannot be
 *  the shipped skill text agreeing with itself. */
const HOST_DESIGN = `THEME TOKENS:
{
  "colors": { "accent": "#0f7b4a" },
  "density": "compact"
}

HOST DESIGN RULES:
Maple never shows a balance without its account name beside it.`;

const listTool: ToolDescriptor = { ...readTool("maple_spend_summary"), title: "Spending summary" };

/** One assembler over the real workspace and the real render seam, with the
 *  host's design brief in the slot composition fills. */
function harness(design?: string) {
  const model = scriptedModel([textTurn("nothing to build")]);
  const assembler = screenAssembler({
    models: seats(model),
    tools: boundRegistry(
      { [listTool.name]: { descriptor: listTool, execute: (): Json => ({ ok: true }) } },
      testGuard(),
    ),
    workspace: async () => testWorkspace(),
    ...(design === undefined ? {} : { design: () => design }),
  });
  return {
    model,
    assemble: async () => await assembler.assemble({ appId: APP, request: "show me my spending" }, ctx()),
  };
}

describe("the writers' design brief", () => {
  it("carries the shipped design law — the same words both writers read", async () => {
    const screen = harness();
    await screen.assemble();
    const brief = screen.model.systemPrompts[0] ?? "";

    // The law, in `.vendo` terms rather than CSS: hierarchy, density, chart
    // choice by data shape, the honest hole, and the island's one styling rule.
    expect(brief).toContain("What a good screen looks like");
    expect(brief).toContain("Lead with the answer.");
    expect(brief).toContain("Never chart two data points");
    expect(brief).toContain("A hole is a `<Cannot>`.");
    expect(brief).toContain("no hex colours, no gradients");
  });

  it("carries the HOST's theme and design rules when composition has them", async () => {
    const screen = harness(HOST_DESIGN);
    await screen.assemble();
    const brief = screen.model.systemPrompts[0] ?? "";

    expect(brief).toContain("THEME TOKENS:");
    expect(brief).toContain("#0f7b4a");
    expect(brief).toContain("HOST DESIGN RULES:");
    expect(brief).toContain("Maple never shows a balance without its account name beside it.");
  });

  it("says nothing about the host's rules when composition has none", async () => {
    const screen = harness();
    await screen.assemble();
    expect(screen.model.systemPrompts[0] ?? "").not.toContain("HOST DESIGN RULES:");
  });
});
