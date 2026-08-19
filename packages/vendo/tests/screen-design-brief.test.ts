/**
 * What the screen agent is told about the PRODUCT.
 *
 * A seam test, like `screen-agent.test.ts` beside it: the brief is read off the
 * scripted model's own system prompt after a real `screenAssembler` run, so what
 * is measured is the text an assembly actually thinks with — never a helper
 * called by hand.
 *
 * Two halves, and they arrive by different routes on purpose. The JOB DESCRIPTION
 * is shipped inside `buildingAppsSkill`, so both writers read the same words; the
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
  it("carries the shipped job description — the same words both writers read", async () => {
    const screen = harness();
    await screen.assemble();
    const brief = screen.model.systemPrompts[0] ?? "";

    // The job, and the two references it sends the writer to. The design law used
    // to be inlined here; it moved into `references/format.md`
    // (`VENDO_FORMAT_REFERENCE`, whose words are pinned in `@vendoai/apps`'s own
    // format-reference.test.ts), so what this seam has to prove is that the
    // POINTER travels — a reference nobody is told to open is a reference nobody
    // reads.
    expect(brief).toContain("# Building an app");
    expect(brief).toContain("host/skills/building-apps/references/format.md");
    expect(brief).toContain("host/components/");
    // The one thing the body must never stop saying: the hands are the mechanism,
    // so a writer does not go hunting for a build tool it has not got.
    expect(brief).toContain("Your hands are how an app gets built.");
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

  it("makes the writer put every value the ask names in TEXT on the screen", async () => {
    // Judged 2026-08-17: screens that answered the shape of an ask while quietly
    // dropping a value it named by name. The writer is the cheapest place to catch
    // that — it is holding the ask — and the rule is what the reviewer grades on
    // afterwards, so the two halves say the same thing.
    //
    // ONE sentence of it. Writing the list out and reading it back was a ritual
    // the model performed in prose and the screen never felt, and the reviewer
    // carries the ask itself now (`judgeScreen`), so the checklist was being paid
    // for twice.
    const screen = harness();
    await screen.assemble();
    const brief = (screen.model.systemPrompts[0] ?? "").replace(/\s+/g, " ");
    expect(brief).toContain("READABLE AS TEXT on the screen");
    expect(brief).not.toContain("take the ask apart");
    expect(brief).not.toContain("Read the list again");
  });

  it("never names the app id — the hands take none, and the brief is a cached prefix", async () => {
    // `save_app` and `edit_app` have no `appId` argument and no path argument, so
    // the sentence naming this app taught the model nothing it could act on — and
    // it was interpolated into the head of a ~16k-token cached prefix, which made
    // the prefix a different one for every app.
    const screen = harness();
    await screen.assemble();
    expect(screen.model.systemPrompts[0] ?? "").not.toContain(APP);
  });
});

/** Everything a measured surface adds to the brief, byte for byte — two bullets
 *  on the note's own opening list. One constant, because the two cases below are
 *  the same claim from either side: this text is there when the host measured, and
 *  the brief is exactly this text away from the one it has always assembled when
 *  nobody did. */
const SURFACE_PARAGRAPH = "\n- You are writing into `420×880` CSS pixels — nothing wider than that is on\n"
  + "  the person's screen.\n"
  + "- What a person sees in that frame is all anyone sees, and EVERYTHING the ask\n"
  + "  names has to be in it — never dropped to make room. Fit is the Kit's job:\n"
  + "  cells truncate, a narrow frame keeps columns by `priority`, panes stack.";

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
  it("names the room the screen has, and asks for everything inside it", async () => {
    // Judged 2026-08-12: eight-column tables whose "Status column is cut off
    // beyond the viewport" and a stat row clipped to "$1,113.1(" — every one of
    // them written by a writer that was never told how wide it was writing.
    const brief = await briefFor({ width: 420, height: 880 });
    expect(brief).toContain("`420×880` CSS pixels");
    expect(brief).toContain(SURFACE_PARAGRAPH);
    // The frame is what is SEEN, never a budget to shed content into: the rubrics
    // grade a screen on the ask being present, so a brief that told the writer to
    // carry "fewer, richer columns" was coaching it to drop what it was asked for.
    expect(brief).not.toContain("Fewer, richer columns");
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
