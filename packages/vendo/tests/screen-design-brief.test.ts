/**
 * What the screen agent is told about the PRODUCT.
 *
 * A seam test, like `screen-agent.test.ts` beside it: the brief is read off the
 * scripted model's own system prompt after a real `screenAssembler` run, so what
 * is measured is the text an assembly actually thinks with — never a helper
 * called by hand.
 *
 * Two halves, and they arrive by different routes on purpose. The design LAW is
 * shipped inside `buildingAppsSkill`, so both writers read the same words; the
 * host's own theme, rules, product brief and components are CONFIGURATION
 * composition holds, and they arrive as one briefing pack the box rung is handed
 * byte for byte (`briefing-pack.test.ts` proves that half).
 */
import { type AppId, type Json, type ToolDescriptor } from "@vendoai/core";
import { type BriefingPack } from "@vendoai/apps/contract";
import { describe, expect, it } from "vitest";
import { assembleScreen, screenAssembler, type ScreenInput } from "../src/screen-agent.js";
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

const APP = "app_design" as AppId;

/** The host's own configuration, as composition carries it, with token values
 *  that appear nowhere else in the brief — so a passing assertion cannot be the
 *  shipped skill text agreeing with itself. */
const HOST_PACK: BriefingPack = {
  theme: {
    colors: {
      background: "#ffffff",
      surface: "#f7f7f5",
      text: "#101010",
      muted: "#6b6b6b",
      accent: "#0f7b4a",
      accentText: "#ffffff",
      danger: "#b3261e",
      border: "#e4e4e0",
    },
    typography: { fontFamily: "Onest", baseSize: "15px" },
    radius: { small: "6px", medium: "10px", large: "16px" },
    density: "compact",
    motion: "reduced",
  },
  designRules: "Maple never shows a balance without its account name beside it.",
  brief: "Maple is a bank for freelancers who invoice in three currencies.",
  catalog: [{ name: "MapleBalanceCard", description: "The account balance card." }],
  hostSemantics: "TOOL RESPONSE SHAPES: maple_spend_summary — shape: { total: :money.cents }",
};

const listTool: ToolDescriptor = { ...readTool("maple_spend_summary"), title: "Spending summary" };

/** One assembler over the real workspace and the real render seam, with the
 *  briefing pack in the slot composition fills. */
function harness(pack?: BriefingPack) {
  const model = scriptedModel([textTurn("nothing to build")]);
  const assembler = screenAssembler({
    models: seats(model),
    tools: boundRegistry(
      { [listTool.name]: { descriptor: listTool, execute: (): Json => ({ ok: true }) } },
      testGuard(),
    ),
    workspace: async () => testWorkspace(),
    ...(pack === undefined ? {} : { briefing: async () => pack }),
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

    // The law: hierarchy, density, chart choice by data shape, the honest hole,
    // and the one styling rule — a screen styles freely, but off the host's own
    // CSS variables, because a hard-coded color is not the product's.
    expect(brief).toContain("What a good screen looks like");
    expect(brief).toContain("Lead with the answer.");
    expect(brief).toContain("Never chart two data points");
    expect(brief).toContain("A hole is a `<Disclaimer>`.");
    expect(brief).toContain("`var(--vendo-color-accent)`");
  });

  it("carries the WHOLE briefing pack when composition has one", async () => {
    const screen = harness(HOST_PACK);
    await screen.assemble();
    const brief = screen.model.systemPrompts[0] ?? "";

    // Every piece, because a pack that arrives with a hole in it is exactly the
    // silent gap this seam exists to close.
    expect(brief).toContain("THEME TOKENS:");
    expect(brief).toContain("#0f7b4a");
    expect(brief).toContain("HOST DESIGN RULES:");
    expect(brief).toContain("Maple never shows a balance without its account name beside it.");
    expect(brief).toContain("Maple is a bank for freelancers who invoice in three currencies.");
    expect(brief).toContain("- MapleBalanceCard: The account balance card.");
    expect(brief).toContain(":money.cents");
  });

  it("says nothing about the host's rules when composition has none", async () => {
    const screen = harness();
    await screen.assemble();
    expect(screen.model.systemPrompts[0] ?? "").not.toContain("HOST DESIGN RULES:");
  });

  it("names away work on the escalate door itself, not only in the skill", async () => {
    // Field (linkwarden 2026-08-08): the skill's §3 teaches the <Server>
    // declaration, but the door's own text listed only real-code reasons to
    // leave — so a schedule ask got assembled as a plain view and no trigger
    // was ever authored. The door must name the away case in the same breath.
    const screen = harness();
    await screen.assemble();
    const brief = (screen.model.systemPrompts[0] ?? "").replace(/\s+/g, " ");
    expect(brief).toContain("must run while nobody is watching");
    expect(brief).toContain("a schedule, a product event");
    expect(brief).toContain("escalate the WHOLE ask");
  });
});

/** Everything a measured surface adds to the brief, byte for byte. One constant,
 *  because the two cases below are the same claim from either side: this text is
 *  there when the host measured, and the brief is exactly this text away from the
 *  one it has always assembled when nobody did. */
const SURFACE_PARAGRAPH = "\n\nYou are writing into `420×880` CSS pixels, and nothing wider than that is\n"
  + "on the person's screen. Fewer, richer columns rather than a table that runs off\n"
  + "the edge, and a stat grid that wraps rather than a fixed count that clips.";

/** One run through `assembleScreen`, which is where a `ScreenInput` — and the
 *  host's viewport with it — enters. Not the `vendo_make` route above: a
 *  `ScreenRequest` carries no dimensions, so this door is where a host opts in.
 *  The model still speaks and never saves, so the brief is all this reads. */
async function briefFor(viewport?: ScreenInput["viewport"]): Promise<string> {
  const model = scriptedModel([textTurn("nothing to build")]);
  await assembleScreen(
    {
      models: seats(model),
      tools: { list: async () => [], call: async () => ({ status: "ok", output: {} }) },
      workspace: testWorkspace(),
      signal: new AbortController().signal,
    },
    { appId: APP, request: "show me my spending", ...(viewport === undefined ? {} : { viewport }) },
  );
  return model.systemPrompts[0] ?? "";
}

describe("the surface the screen is written for", () => {
  it("names the room the screen has, and what to spend it on", async () => {
    // Judged 2026-08-12: eight-column tables whose "Status column is cut off
    // beyond the viewport" and a stat row clipped to "$1,113.1(" — every one of
    // them written by a writer that was never told how wide it was writing.
    const brief = await briefFor({ width: 420, height: 880 });
    expect(brief).toContain("`420×880` CSS pixels");
    expect(brief).toContain(SURFACE_PARAGRAPH);
  });

  it("says nothing about a surface nobody measured", async () => {
    // The half-filled brief is what this stops: a line that announces a width and
    // then has none is worse than the silence the writer has always had.
    const bare = await briefFor();
    expect(bare).not.toContain("CSS pixels");
    // …and byte for byte, that silence is the whole difference.
    expect((await briefFor({ width: 420, height: 880 })).replace(SURFACE_PARAGRAPH, "")).toBe(bare);
  });
});
