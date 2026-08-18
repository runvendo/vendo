/**
 * Liveness is a claim about a BROWSER — change the host's answers under a saved
 * page, paint it again, and see whether the numbers on it followed — so nothing
 * here is simulated. The seam is the one `render.ts` injects into every
 * contender's document, the world is a real world off disk, and both paintings
 * happen in the same headless Chromium a run uses.
 *
 * The only thing written here is the contender's page, which is the one thing a
 * contender writes. Two of them: one that asks the host at render, one that
 * printed the same figures into its markup. They are indistinguishable in a
 * screenshot and must not be indistinguishable here.
 *
 * The digit search is the only thing that gets to say a value is LIVE — finding
 * the new digits is evidence and needs nobody's opinion — so a screen that is
 * fully bound asks no model at all, and those tests are real all the way down.
 * Every STALE accusation is a model's to decide, and that model is the one
 * double in this file: scripted to uphold, to dismiss, and to be unreachable,
 * because those are the three answers the counting has to get right.
 *
 * The last test is the whole retroactive path over one real directory: the run's
 * OWN writer puts two cases on disk, `genbench liveness` scores that folder in
 * place, and the run's own reader is what these assertions read back. No judge,
 * no contender.
 */
import { bootScreen, flattenTree, KIT_COMPONENT_NAMES, warmScreenEngine } from "@vendoai/apps/contract";
import { VENDO_TREE_FORMAT, type UIPayload } from "@vendoai/core";
import { MockLanguageModelV3 } from "ai/test";
import { transform } from "esbuild";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runFloor, type FloorResult } from "../src/floor.js";
import { JudgeContract, type JudgeResult } from "../src/judge.js";
import { ADJUDICATOR_PROMPT, AdjudicatorContract, liveness } from "../src/liveness.js";
import { MODEL_IDS, usdFor } from "../src/meter.js";
import { probe } from "../src/probe.js";
import type { RunSummary } from "../src/report.js";
import { authoredPage, bundleMount, openBrowser, pageHtml, type Shooter } from "../src/render.js";
import { scoreLiveness, writeCase, type CaseResult } from "../src/run.js";
import { cannedResponse, loadCases, loadWorld, type Case, type World } from "../src/world.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
let world: World;
let testCase: Case;
let shooter: Shooter;
let bundle: string;
beforeAll(async () => {
  world = await loadWorld(join(root, "worlds", "maple"));
  testCase = (await loadCases(join(root, "worlds", "maple", "cases.json"))).find(
    (entry) => entry.id === "spend-overview",
  )!;
  bundle = await bundleMount();
  shooter = await openBrowser();
}, 120_000);
afterAll(async () => await shooter.close());

/** What `get_spending` answers with — the values every page below puts on the
 *  screen. Read off the world rather than typed, because the world is the truth
 *  and a number typed here would be a second one. */
const spending = (): ReadonlyArray<{ category: string; amount: number }> =>
  (world.tools.find((tool) => tool.name === "get_spending")!.data as {
    data: Array<{ category: string; amount: number }>;
  }).data;

/** How many of them there are — the floor under what any of these pages can be
 *  scored out of. */
const rows = (): number => spending().length;

/** The checking account's balance, which is in the world's data and in no page's
 *  query below: the one figure a screen here can print without ever re-reading
 *  it, and so the one the digit search can accuse. */
const checking = (): number =>
  (world.tools.find((tool) => tool.name === "list_accounts")!.data as {
    data: Array<{ id: string; balance: number }>;
  }).data.find((row) => row.id === "acc_checking")!.balance;

/** What one accusation put over the wire, as the adjudicator read it. */
const evidence = (call: { prompt: unknown }): string =>
  (JSON.parse(JSON.stringify(call.prompt)) as Array<{ content: unknown }>)
    .flatMap((message) => (Array.isArray(message.content) ? (message.content as Array<{ text?: string }>) : []))
    .flatMap((part) => part.text ?? [])
    .join("\n");

/** A million tokens each way, so the dollars below are the pinned model's rate
 *  read straight off the table rather than a rounding. */
const MTOK = {
  inputTokens: { total: 1_000_000, noCache: 1_000_000, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1_000_000, text: 1_000_000, reasoning: 0 },
};

/**
 * The adjudicator, doubled: it answers every accusation the same way and keeps
 * what it was asked, so a test can read the evidence that actually went over the
 * wire. Handed an Error instead of a verdict, it is an adjudicator nobody can
 * reach.
 */
function adjudicator(reply: { verdict: string; note: string } | Error): {
  model: MockLanguageModelV3;
  asked: () => readonly string[];
} {
  const asked: string[] = [];
  const model = new MockLanguageModelV3({
    doGenerate: async (call) => {
      asked.push(evidence(call));
      if (reply instanceof Error) throw reply;
      return {
        content: [{ type: "text" as const, text: JSON.stringify(reply) }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: MTOK,
        warnings: [],
      };
    },
  });
  return { model, asked: () => asked };
}

/** An adjudicator that upholds whatever it is shown — what the baked pages below
 *  are scored under, since every accusation against them is a true one. */
const upholds = (): MockLanguageModelV3 => adjudicator({ verdict: "stale", note: "still the old figure" }).model;

/** A screen that ASKS: it reads the host's answer at render and prints what came
 *  back. Nothing about it is clever — that is the point, since a screen this
 *  simple is what every contender claims to have written. */
const FETCHES = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title></head>
<body><h1>Spending</h1><ul id="rows"></ul>
<script>
  var answer = window.vendo.callTool("get_spending", {});
  document.getElementById("rows").innerHTML = answer.output.data
    .map(function (row) { return "<li>" + row.category + " " + row.amount + "</li>"; })
    .join("");
</script></body></html>`;

/** The same screen with the same figures typed into it — what a model writes
 *  when it has been shown the data and decides it does not need to ask. It is
 *  correct today and wrong tomorrow, and a screenshot cannot tell the two
 *  apart. */
const BAKED = (): string => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title></head>
<body><h1>Spending</h1><ul>${spending()
  .map((row) => `<li>${row.category} ${row.amount}</li>`)
  .join("")}</ul></body></html>`;

/** A screen with no number on it at all. It did not fail this check and it did
 *  not pass it — there was nothing to look at. */
const WORDLESS = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title></head>
<body><h1>Spending</h1><p>Nothing to show right now.</p></body></html>`;

/** The shape the real corpus produces, and the one the mechanical check alone
 *  cannot read: a screen that asks for its rows and prints ONE figure it never
 *  asked for. Everything it fetched follows the data; the typed balance does
 *  not, so the search accuses exactly one value and a model has to say what that
 *  value is. */
const MIXED = (): string => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title></head>
<body><h1>Spending</h1><p>Checking ${checking()}</p><ul id="rows"></ul>
<script>
  var answer = window.vendo.callTool("get_spending", {});
  document.getElementById("rows").innerHTML = answer.output.data
    .map(function (row) { return "<li>" + row.category + " " + row.amount + "</li>"; })
    .join("");
</script></body></html>`;

describe("liveness", () => {
  it("scores a screen that asks the host at render as live", async () => {
    const alive = await liveness(shooter, authoredPage(FETCHES, world, "diy-sonnet"));

    // Every value it showed moved when the data moved, and it showed at least
    // the rows it asked for.
    expect(alive.displayed).toBeGreaterThanOrEqual(rows());
    expect(alive.live).toBe(alive.displayed);
    expect(alive.vacuous).toBeUndefined();
    // And nothing was accused, so nothing was asked: finding the new digits is
    // evidence, and a fully bound screen costs this axis nothing at all. The
    // call above passes no model, so a screen that DID ask would have reached a
    // provider from inside a test.
    expect(alive.adjudications).toBeUndefined();
  }, 120_000);

  it("scores a screen that printed the same figures into its markup as baked", async () => {
    const alive = await liveness(shooter, authoredPage(BAKED(), world, "diy-sonnet"), { model: upholds() });

    // It showed exactly what the live screen showed — that is what makes the two
    // indistinguishable in a picture — and not one figure followed the data.
    expect(alive.displayed).toBeGreaterThanOrEqual(rows());
    expect(alive.live).toBe(0);
    expect(alive.vacuous).toBeUndefined();
    // Every one of them was an accusation, and every one of them was put to a
    // model before it counted against the screen.
    expect(alive.adjudications).toHaveLength(alive.displayed);
  }, 120_000);

  it("calls a screen that displayed none of the data vacuous rather than failed", async () => {
    const alive = await liveness(shooter, authoredPage(WORDLESS, world, "diy-sonnet"));

    expect(alive).toEqual({ live: 0, displayed: 0, vacuous: true });
  }, 120_000);
});

/**
 * The half a digit search cannot decide.
 *
 * A run of digits missing from the repainted screen is an ACCUSATION and never a
 * verdict: `people-ops/headcount-overview` scored 5/6 on a screen where every
 * figure was computed at render, because the world's `250000` sits inside the
 * payroll total `171250000` the screen prints and a total of four rows moves by
 * four, not by one. The same lesson the honesty check learned when it stopped
 * matching strings and became a line on the judge's rubric.
 *
 * So: three answers, three ways of counting, and the screen underneath them is
 * one page — everything it asked for is genuinely live, and one typed balance is
 * genuinely accused.
 */
describe("a stale accusation", () => {
  it("counts against the screen when the adjudicator upholds it, stamped with who decided", async () => {
    const { model } = adjudicator({ verdict: "stale", note: "the Checking line, still the old balance" });
    const alive = await liveness(shooter, authoredPage(MIXED(), world, "diy-sonnet"), { model });

    // The rows it asked for, plus the one figure it typed — which is now in the
    // denominator and not in the numerator, because a model said it belonged
    // there.
    expect(alive.live).toBeGreaterThanOrEqual(rows());
    expect(alive.displayed).toBe(alive.live + 1);
    expect(alive.adjudications).toEqual([
      {
        was: String(checking()),
        now: String(checking() + 1),
        verdict: "stale",
        note: "the Checking line, still the old balance",
        cost: {
          usage: { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 1 },
          // Priced through the same table the contenders are — at the pinned
          // model's own rate, which is $1 in and $5 out per MTok.
          usd: usdFor(
            { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 1 },
            MODEL_IDS.haiku,
          ),
        },
      },
    ]);
    expect(alive.adjudicator).toEqual(AdjudicatorContract);
  }, 120_000);

  it("leaves the denominator when the adjudicator dismisses it as a non-echo", async () => {
    const { model } = adjudicator({ verdict: "not-a-data-echo", note: "falls inside a longer figure" });
    const alive = await liveness(shooter, authoredPage(MIXED(), world, "diy-sonnet"), { model });

    // The headcount case's own reading: everything the screen really displayed
    // followed the data, and the missing digits were the instrument's problem
    // rather than the screen's.
    expect(alive.live).toBeGreaterThanOrEqual(rows());
    expect(alive.displayed).toBe(alive.live);
    expect(alive.vacuous).toBeUndefined();
    expect(alive.adjudications).toEqual([
      expect.objectContaining({ was: String(checking()), verdict: "not-a-data-echo" }),
    ]);
  }, 120_000);

  it("stands unadjudicated, in neither total, when nobody can be reached to decide it", async () => {
    const { model } = adjudicator(new Error("the adjudicator is unreachable"));
    const alive = await liveness(shooter, authoredPage(MIXED(), world, "diy-sonnet"), { model });

    // The same two numbers a dismissal produces — an unanswered question is not
    // a failure — and a record that says nobody answered it, which is the whole
    // difference between degrading honestly and quietly scoring well.
    expect(alive.live).toBeGreaterThanOrEqual(rows());
    expect(alive.displayed).toBe(alive.live);
    expect(alive.adjudications).toEqual([
      expect.objectContaining({ was: String(checking()), verdict: "unadjudicated" }),
    ]);
    expect(alive.adjudications![0]!.note).toContain("unreachable");
  }, 120_000);

  it("is put to the adjudicator alone, with both windows of the screen it was read off", async () => {
    const { model, asked } = adjudicator({ verdict: "not-a-data-echo", note: "part of another number" });
    await liveness(shooter, authoredPage(MIXED(), world, "diy-sonnet"), { model });

    // One call for the one value it accused, and not one for any value it
    // found: the optimist half of this axis is free.
    expect(asked()).toHaveLength(1);
    const sent = asked()[0]!;
    expect(sent).toContain(`digits read ${checking()} before the move`);
    expect(sent).toContain(`would read ${checking() + 1} after it`);
    // Both paintings, each carrying the words the figure stands under — which is
    // the entire evidence for whether the screen displays it at all.
    const [, before, after] = sent.split(/BEFORE —|AFTER —/);
    expect(before).toContain("Checking");
    expect(after).toContain("Checking");
  }, 120_000);

  it("is decided under a prompt the result can be checked against", () => {
    expect(AdjudicatorContract.promptHash).toBe(createHash("sha256").update(ADJUDICATOR_PROMPT).digest("hex"));
    // The grader is pinned off the run's model table, like the judge's, and is
    // not the class any default column races.
    expect(AdjudicatorContract.model).toBe(MODEL_IDS.haiku);
  });
});

describe("liveness on disk", () => {

  /**
   * The retroactive half: a run recorded before this axis existed is scored for
   * it from the pages it already saved, in place, with no model anywhere.
   *
   * Both real sides over one real directory — the run's writer, then the
   * liveness pass, then the run's own summary and page read back — because the
   * saved page IS the evidence and a harness that mocked it would prove nothing
   * about what a benchmark folder holds.
   */
  it("scores a saved run folder in place, and tells the two columns apart in its summary and its page", async () => {
    const runDir = join(await mkdtemp(join(tmpdir(), "genbench-liveness-")), "runs", "2026-01-01T00-00-00");
    await mkdir(runDir, { recursive: true });
    for (const [contender, html] of [
      ["vendo-sonnet", FETCHES],
      ["diy-claude", BAKED()],
    ] as const) {
      await writeCase(runDir, {
        outcome: undefined,
        html: authoredPage(html, world, contender),
        shot: undefined,
        result: saved(contender),
      });
    }

    expect(await scoreLiveness({ runDir, jobs: 2 }, { model: upholds() })).toBe(0);

    const asked = await resultIn(runDir, "vendo-sonnet");
    const typed = await resultIn(runDir, "diy-claude");
    expect(asked.liveness!.live).toBe(asked.liveness!.displayed);
    expect(asked.liveness!.displayed).toBeGreaterThanOrEqual(rows());
    expect(typed.liveness!.live).toBe(0);
    // Everything else the folder already said is untouched: this pass grades
    // nothing and re-decides nothing.
    expect(typed.floor).toEqual(saved("diy-claude").floor);
    expect(typed.judged).toEqual(saved("diy-claude").judged);

    // And the two files that are read off the results say it too — the summary
    // per column, the page as its own row under the floor cells.
    const summary = JSON.parse(await readFile(join(runDir, "summary.json"), "utf8")) as RunSummary;
    expect(summary.columns["vendo-sonnet"]!.liveness).toEqual({
      live: asked.liveness!.displayed,
      displayed: asked.liveness!.displayed,
      vacuous: 0,
    });
    expect(summary.columns["diy-claude"]!.liveness).toEqual({
      live: 0,
      displayed: typed.liveness!.displayed,
      vacuous: 0,
    });
    const preview = await readFile(join(runDir, "preview.html"), "utf8");
    expect(preview).toContain("<th>liveness</th>");
    expect(preview).toContain(`<td>${asked.liveness!.live}/${asked.liveness!.displayed}</td>`);
    expect(preview).toContain(`<td>0/${typed.liveness!.displayed}</td>`);
  }, 180_000);
});

// ------------------------------------------- the page the PRODUCT renders

/**
 * The same question asked of the vendo column, whose page nobody writes by hand:
 * the product compiles a component screen and `mount.tsx` mounts the product's
 * own renderer over the payload the checks floor emitted for it.
 *
 * So the fixture is a real one all the way down — the screen's TSX compiled the
 * way the product compiles it, booted in the real engine, flattened into the
 * same `{ formatVersion, nodes, root, interactive }` the render seam serves
 * (`apps/src/server/checking/floor.ts:240`). That payload IS the snapshot: its
 * nodes hold whatever the assembler's own queries answered with, frozen at the
 * instant it was written. Whether the page built from it is live is a question
 * about the mount, and it is asked here through the same seam, in the same
 * browser, as the hand-written pages above.
 *
 * TWO SCREENS, because "vendo is live" must not be something this file can
 * declare. One declares a query; one types the same figures into its own JSX and
 * declares none. Both are component screens, both go through the same mount, and
 * only the first can follow the data — the mechanism has to be the screen's own
 * queries or it is not a mechanism.
 */
const compiled = async (tsx: string): Promise<string> =>
  (await transform(tsx, {
    loader: "tsx",
    format: "cjs",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
  })).code;

/** One screen as the product serves it: its first paint flattened, plus the
 *  interactive half that can produce the next one — the engine's own boot
 *  against the world's canned answers, which is what the checks floor does on
 *  the way to a screen. */
async function servedPayload(tsx: string, plan: ReadonlyArray<{ tool: string }>): Promise<UIPayload> {
  const compiledSource = await compiled(tsx);
  const queries = Object.fromEntries(plan.map(({ tool }) =>
    [tool, cannedResponse(world.tools.find((known) => known.name === tool)!)]));
  await warmScreenEngine();
  const screen = bootScreen({ compiledSource, queries, catalog: KIT_COMPONENT_NAMES, now: Date.now() });
  try {
    const flat = flattenTree(screen.tree());
    return {
      formatVersion: VENDO_TREE_FORMAT,
      root: flat.root,
      nodes: Object.values(flat.nodes),
      interactive: { compiledSource, queries, queryPlan: plan },
      streaming: false,
    } as unknown as UIPayload;
  } finally {
    screen.dispose();
  }
}

/** A component screen that ASKS: it declares its query and prints the rows that
 *  came back. Every screen the product's own agent writes reads like this. */
const SCREEN_ASKS = `
import { Stack, Text, useQuery } from "@vendo/screen";

export default function Spending() {
  const spending = useQuery("get_spending");
  return (
    <Stack gap={8}>
      <Text text="Spending" />
      {spending.data.map((row) => <Text key={row.category} text={row.category + " " + row.amount} />)}
    </Stack>
  );
}
`;

/** The same screen with the same figures typed into its JSX and no query at all.
 *  Nothing downstream can save it: there is no plan to re-run, so it paints what
 *  it was written with forever. */
const SCREEN_TYPES = (): string => `
import { Stack, Text } from "@vendo/screen";

export default function Spending() {
  return (
    <Stack gap={8}>
      <Text text="Spending" />
${spending().map((row) => `      <Text text="${row.category} ${row.amount}" />`).join("\n")}
    </Stack>
  );
}
`;

/** A screen that both reads and ACTS — what an `action` case asks for, and the
 *  page the floor's probe has to keep working on after the mount re-fetched. */
const SCREEN_ACTS = `
import { Button, Stack, Text, tools, useQuery } from "@vendo/screen";

export default function Spending() {
  const spending = useQuery("get_spending");
  return (
    <Stack gap={8}>
      <Text text="Spending" />
      {spending.data.map((row) => <Text key={row.category} text={row.category + " " + row.amount} />)}
      <Button label="Cancel transfer" onClick={() => tools.cancel_transfer({ id: "tr_1" })} />
    </Stack>
  );
}
`;

const productPage = async (tsx: string, plan: ReadonlyArray<{ tool: string }>): Promise<string> =>
  pageHtml(await servedPayload(tsx, plan), world, bundle, "vendo-sonnet");

describe("the screen the product renders", () => {
  it("re-runs its query at render, so every figure it shows follows the data", async () => {
    const alive = await liveness(shooter, await productPage(SCREEN_ASKS, [{ tool: "get_spending" }]));

    expect(alive.displayed).toBeGreaterThanOrEqual(rows());
    expect(alive.live).toBe(alive.displayed);
    expect(alive.vacuous).toBeUndefined();
  }, 180_000);

  it("is baked when the screen itself declared no query, through that same mount", async () => {
    const alive = await liveness(shooter, await productPage(SCREEN_TYPES(), []), { model: upholds() });

    // Indistinguishable from the live one in a picture — it shows the same
    // figures — and not one of them moved.
    expect(alive.displayed).toBeGreaterThanOrEqual(rows());
    expect(alive.live).toBe(0);
    expect(alive.vacuous).toBeUndefined();
  }, 180_000);

  it("still clears the floor once it has re-fetched: it renders, and its control is live", async () => {
    const visit = await shooter.visit(await productPage(SCREEN_ACTS, [{ tool: "get_spending" }]));
    const shot = await visit.shot();
    // `visit` returns on the settle signal, so this reading is taken at the
    // moment the shot is taken and the probe would start pressing: the query is
    // already asked and answered. That is the whole claim behind deleting the
    // flat boot grace — the wait is earned by work that has finished, not spent
    // on a timer.
    const atSettle = await visit.page.evaluate(() => window.vendo.calls.map((call) => call.name));
    // The run's own order: shot first, then the probe presses everything.
    const trace = await probe(visit).finally(() => visit.close());

    const floor = runFloor({
      world,
      artifact: SCREEN_ACTS,
      blocking: [],
      trace,
      renders: shot.renders,
      tags: ["action"],
    });

    // The screen re-ran its query and still painted, and the console stayed
    // quiet doing it.
    expect(shot.renders).toBe(true);
    expect(shot.visibleText).toContain("housing");
    expect(atSettle).toEqual(["get_spending"]);
    // The boot's own reads are the page's, not the press's — the probe reads a
    // press against the recorder as it stood before it, so nothing the mount
    // fetched is credited to a control.
    expect(trace).toHaveLength(1);
    expect(floor.wiredActions.bindings).toContainEqual(
      expect.objectContaining({ tool: "cancel_transfer", known: true, argsValid: true }),
    );
    expect(floor.wiredActions.acted).toBe("tool");
    expect(floor.pass).toBe(true);
  }, 180_000);
});

const PASSING: FloorResult = {
  delivered: true,
  renders: true,
  valid: true,
  blocking: [],
  wiredActions: { pass: true, pressed: 0, bindings: [] },
  pass: true,
};

const JUDGED: JudgeResult = {
  lines: [{ line: "shows every category the tool returned", source: "case", verdict: "pass", note: "six rows" }],
  degraded: false,
};

/** A case as a run left it: everything a saved result carries, and no liveness —
 *  which is every result recorded before tonight. */
const saved = (contender: string): CaseResult => ({
  run: "2026-01-01T00-00-00",
  contender,
  model: "claude-sonnet-5",
  case: testCase.id,
  prompt: testCase.prompt,
  lane: testCase.lane,
  shape: testCase.shape,
  floor: PASSING,
  timing: { settledMs: 41_000 },
  cost: { usage: { inputTokens: 9_000, outputTokens: 4_000, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 1 }, usd: 0.058 },
  islands: 0,
  clientOnly: 0,
  trace: [],
  consoleErrors: [],
  world: world.hash,
  caseHash: "0".repeat(16),
  judged: JUDGED,
  judgeContract: JudgeContract,
  gitSha: "a".repeat(40),
  agentSdkVersion: "0.3.214",
});

const resultIn = async (runDir: string, contender: string): Promise<CaseResult> =>
  JSON.parse(await readFile(join(runDir, contender, testCase.id, "result.json"), "utf8")) as CaseResult;
