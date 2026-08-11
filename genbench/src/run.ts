import { createAnthropic } from "@ai-sdk/anthropic";
import type { UIPayload } from "@vendoai/core";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { auditFloor } from "./audit.js";
import { claudeCodeDriver, WALL_CLOCK_MS } from "./claude-code.js";
import { diyDriver } from "./diy.js";
import { checks, runFloor, type FloorResult } from "./floor.js";
import { judge, JudgeContract, rubricLines, type JudgeResult } from "./judge.js";
import { meteredModel, MODEL_IDS, type Meter, type ModelAlias, type UsageTotals } from "./meter.js";
import { probe, type Probed } from "./probe.js";
import { authoredPage, bundleMount, openBrowser, pageHtml, type Shot } from "./render.js";
import { tally, writePreview } from "./report.js";
import { vendoDriver } from "./vendo.js";
import { caseHash, loadCases, loadWorld, worldForCase, type Case, type Lane, type World } from "./world.js";

export type HarnessId = "vendo" | "diy" | "claude-code";

export interface ContenderId {
  readonly harness: HarnessId;
  readonly model: ModelAlias;
  /** Folder and report-column name, e.g. `vendo-sonnet`. */
  readonly slug: string;
}

export interface RunRequest {
  /** Already scoped to this case's data overrides. */
  readonly world: World;
  readonly testCase: Case;
  /** Already metered — the run's only source of tokens, dollars and time. */
  readonly meter: Meter;
}

export interface RunOutcome {
  readonly artifact?: string;
  /** What the product's own checks floor refuses to paint in the delivered
   *  artifact. Empty means the bytes on disk are the screen that painted. */
  readonly blocking: readonly string[];
  /** The settled screen, as the product itself compiled it. */
  readonly payload?: UIPayload;
  /** Said by a contender whose `artifact` is ALREADY a document — the one way a
   *  contender reports a page it wrote itself. There is no compile between the
   *  bytes it saved and the page that mounts, so the artifact lands once, as
   *  `page.html`, and never as `artifact.tsx`. */
  readonly format?: "html";
  /** A contender billed by its own engine reports its spend here — the run's
   *  meter never saw those tokens. Priced through the same table all the same. */
  readonly usage?: UsageTotals;
  readonly usd?: number;
  /** When the contender had something new to show. Only the clock is shared —
   *  what each snapshot holds is the driver's own business. */
  readonly snapshots: ReadonlyArray<{ atMs: number }>;
  readonly firstRenderMs?: number;
  readonly settledMs: number;
  /** The contender's own failure sentence, when it has one. */
  readonly failure?: string;
}

/** A driver does not name itself: its key in `DRIVERS` is its identity, and
 *  that is what the run reads. */
export interface Contender {
  run(request: RunRequest): Promise<RunOutcome>;
}

export interface CaseResult {
  readonly run: string;
  readonly contender: string;
  readonly model: string;
  readonly case: string;
  readonly prompt: string;
  readonly lane: Lane;
  readonly floor: FloorResult;
  readonly timing: { firstRenderMs?: number; settledMs: number };
  readonly cost: { usage: UsageTotals; usd: number };
  /** Nodes the writer generated as islands rather than assembling from the Kit. */
  readonly islands: number;
  /** Kit charts on the screen — the parts that only exist once a browser has
   *  measured them, and so the reason the page is mounted for real. */
  readonly clientOnly: number;
  /** Every control the probe pressed and what each one asked the host to do. */
  readonly trace: readonly Probed[];
  /** What the browser complained about while painting this screen. */
  readonly consoleErrors: readonly string[];
  readonly world: string;
  /** This case as it was authored — prompt, pass lines and data override. Two
   *  results compare only if BOTH stamps match: `world` says what product the
   *  screen was built against, this says what was asked of it. It cannot be
   *  called `case` — that key already carries the id. */
  readonly caseHash: string;
  /** The other half of the score: one verdict per rubric line, from a judge that
   *  saw the screenshot, the trace and the source and not whose they were. */
  readonly judged: JudgeResult;
  /** The grader those verdicts came from. Two runs' verdicts only compare if
   *  this matches — a different model, rubric or prompt is a different exam. */
  readonly judgeContract: typeof JudgeContract;
  readonly failure?: string;
}

/** Declaration order is column order — the report never sorts by who finished
 *  first. Every driver takes the model its column was asked for; the two that
 *  are metered by the run read it off `meter.model` instead and ignore it. */
const DRIVERS: Record<HarnessId, (model: ModelAlias) => Contender> = {
  vendo: vendoDriver,
  diy: diyDriver,
  "claude-code": (model) => claudeCodeDriver({ model }),
};

/** The only world folder there is today. */
const DEFAULT_WORLD = "maple";

export interface Args {
  readonly only?: string;
  readonly models: readonly ModelAlias[];
  /** A folder under `worlds/`, holding `world.json`, `cases.json` and any face. */
  readonly world: string;
}

export function parseArgs(argv: readonly string[]): Args {
  const rest = argv[0] === "run" ? argv.slice(1) : argv;
  let only: string | undefined;
  let models: readonly ModelAlias[] = ["sonnet"];
  let world = DEFAULT_WORLD;
  let index = 0;
  while (index < rest.length) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (value === undefined) throw new Error(`genbench: "${flag}" needs a value`);
    if (flag === "--prompt") only = value;
    else if (flag === "--models") models = value.split(",").map(asAlias);
    else if (flag === "--world") world = value;
    else throw new Error(`genbench: unexpected argument "${flag}"`);
    index += 2;
  }
  return { ...(only === undefined ? {} : { only }), models, world };
}

function asAlias(value: string): ModelAlias {
  if (!Object.hasOwn(MODEL_IDS, value)) throw new Error(`genbench: unknown model "${value}"`);
  return value as ModelAlias;
}

/** Every contender that has a driver today, in every requested model. */
export function contenders(models: readonly ModelAlias[]): readonly ContenderId[] {
  return Object.keys(DRIVERS).flatMap((harness) =>
    models.map((model) => ({ harness: harness as HarnessId, model, slug: `${harness}-${model}` })),
  );
}

/** The recharts-backed Kit components (packages/ui/src/kit/charts/). */
const CHARTS = new Set(["LineChart", "BarChart", "DonutChart", "Sparkline"]);

/**
 * One contender's whole budget for one case — generation, paint and probe.
 *
 * Per harness rather than one number for the row: an agentic build runs its own
 * ten-minute wall clock (`WALL_CLOCK_MS`) before it has delivered anything, so a
 * five-minute case would end it early and record a timeout the contender never
 * had. The one-call columns keep the tighter bound they have never needed more
 * than.
 */
export const CASE_TIMEOUT_MS: Readonly<Record<HarnessId, number>> = {
  vendo: 5 * 60_000,
  diy: 5 * 60_000,
  "claude-code": WALL_CLOCK_MS + 2 * 60_000,
};

/**
 * One contender's whole attempt as a settled value.
 *
 * Its own crash and its own silence become results here, never exceptions, so
 * the row can be gathered with `Promise.all`: a column that dies takes down
 * nothing but itself, and every column keeps its place.
 *
 * Losing the race does not STOP the work — nothing here can reach inside a
 * driver mid-generation — so the work is handed a signal and can ask. It
 * matters because the browser is shared: a column that walks on after its
 * budget would otherwise open a page on it a case or two later, with nobody
 * waiting for what that page shows.
 */
export async function attempt<T>(
  work: (lost: AbortSignal) => Promise<T>,
  budgetMs: number,
): Promise<{ done?: T; failure?: string }> {
  const lost = new AbortController();
  return await Promise.race([
    work(lost.signal).then(
      (done) => ({ done }),
      (error: unknown) => ({ failure: error instanceof Error ? error.message : String(error) }),
    ),
    new Promise<{ failure: string }>((settle) =>
      setTimeout(() => {
        lost.abort();
        settle({ failure: "timeout" });
      }, budgetMs).unref(),
    ),
  ]);
}

/**
 * The rubric for a column that produced no screen: every line failed.
 *
 * That is the CONTENDER failing, not the judge, so it is not degraded and no
 * judge call is spent on a screenshot that does not exist. Graded rather than
 * skipped, because a column that quietly drops out of the rubric is a benchmark
 * that flatters whoever crashed.
 */
export const ungraded = (caseLines: readonly string[], styleLines: readonly string[]): JudgeResult => ({
  lines: rubricLines(caseLines, styleLines).map((entry) => ({
    ...entry,
    verdict: "fail" as const,
    note: "no screen was delivered to grade",
  })),
  degraded: false,
});

/**
 * A window is opened only for the run it was asked for.
 *
 * `--prompt` is one person watching one case, and a window is the point of it.
 * A full run, anything under `CI`, and anyone who says `GENBENCH_NO_OPEN=1` get
 * the path on stdout instead — a browser stealing focus part-way through a
 * five-case run is a bug, and on a build agent it is a hang.
 */
export const shouldOpen = (args: Args, env: NodeJS.ProcessEnv): boolean =>
  args.only !== undefined && env["CI"] === undefined && env["GENBENCH_NO_OPEN"] !== "1";

/**
 * The floor decides the run's exit code, and nothing else does.
 *
 * The judge is a third party on someone else's infrastructure; the floor is
 * mechanical, local and cannot be unwell. A judge outage must not turn the
 * founder's live loop red, and a rubric line the judge failed is this
 * benchmark's finding rather than its malfunction — both are said loudly in
 * `result.json` and in the preview instead.
 */
export const exitCode = (results: readonly CaseResult[]): number =>
  results.every((result) => result.floor.pass) ? 0 : 1;

const nodesOf = (payload: UIPayload | undefined): ReadonlyArray<{ source?: string; component?: string }> =>
  (payload as { nodes?: Array<{ source?: string; component?: string }> } | undefined)?.nodes ?? [];

/**
 * One column's evidence on disk — the run folder's whole layout, in one place.
 *
 * The nesting and the filenames are a seam: `report.ts` spells them again, on its
 * own, to read this folder back. `run-folder.test.ts` drives this writer and that
 * reader over one real directory, which is the only thing keeping the two
 * spellings honest.
 */
export async function writeCase(
  runDir: string,
  wrote: {
    readonly outcome: RunOutcome | undefined;
    readonly html: string | undefined;
    readonly shot: Shot | undefined;
    readonly result: CaseResult;
  },
): Promise<void> {
  const caseDir = join(runDir, wrote.result.contender, wrote.result.case);
  await mkdir(caseDir, { recursive: true });
  // Only a compiled artifact gets its own file.
  if (wrote.outcome?.artifact !== undefined && wrote.outcome.format !== "html") {
    await writeFile(join(caseDir, "artifact.tsx"), wrote.outcome.artifact);
  }
  if (wrote.html !== undefined) await writeFile(join(caseDir, "page.html"), wrote.html);
  if (wrote.shot !== undefined) await writeFile(join(caseDir, "screenshot.png"), wrote.shot.png);
  await writeFile(join(caseDir, "result.json"), `${JSON.stringify(wrote.result, null, 2)}\n`);
}

async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey === undefined || apiKey === "") {
    console.error("genbench: ANTHROPIC_API_KEY is not set");
    return 1;
  }

  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const worldDir = join(root, "worlds", args.world);
  const world = await loadWorld(worldDir);
  const all = await loadCases(join(worldDir, "cases.json"));
  const cases = all.filter((entry) => args.only === undefined || entry.id === args.only);
  if (cases.length === 0) throw new Error(`genbench: no case matches --prompt "${args.only ?? ""}"`);

  const runId = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const runDir = join(root, "runs", runId);
  const anthropic = createAnthropic({ apiKey });
  const bundle = await bundleMount();
  const shooter = await openBrowser();
  const results: CaseResult[] = [];
  /** The world each case was actually graded against — what the report's data
   *  panel shows, so a person can check any number on any screen against it. */
  const worlds: Record<string, World> = {};

  /** One column of one case, start to finish, reporting rather than throwing. */
  const runOne = async (contender: ContenderId, testCase: Case, scoped: World): Promise<CaseResult> => {
    const modelId = MODEL_IDS[contender.model];
    // Its own meter, so a sibling's tokens and a sibling's clock are never
    // charged to this column.
    const meter = meteredModel(anthropic(modelId), modelId);

    // Raced against the clock as one unit: generation, paint and probe all spend
    // the person's wait, so one budget covers all three.
    const { done, failure: broke } = await attempt(async (lost) => {
      const outcome = await DRIVERS[contender.harness](contender.model).run({ world: scoped, testCase, meter });
      // Either the product compiled a payload into a page, or the contender
      // handed over an artifact that already IS a document. From here on both
      // are just a page.
      const authored = outcome.format === "html" ? outcome.artifact : undefined;
      const html =
        authored !== undefined
          ? authoredPage(authored, scoped, contender.slug)
          : outcome.payload === undefined
            ? undefined
            : pageHtml(outcome.payload, scoped, bundle, contender.slug);
      // This case has already been recorded as a timeout and the row has moved
      // on. Painting it now would spend the shared browser on a screen nobody
      // is waiting for, while the case that IS being graded is shot beside it.
      if (html === undefined || lost.aborted) return { outcome, trace: [] as Probed[] };
      const visit = await shooter.visit(html, { authored: authored !== undefined });
      try {
        return { outcome, html, shot: await visit.shot(), trace: await probe(visit) };
      } finally {
        await visit.close();
      }
    }, CASE_TIMEOUT_MS[contender.harness]);

    const outcome = done?.outcome;
    const shot: Shot | undefined = done?.shot;
    const trace = done?.trace ?? [];
    const artifact = outcome?.artifact;
    // The fabrication check's verdict — every number on the screen answered for
    // by a program the harness ran — and outside the contender's budget for the
    // same reason the judge is: the wait is the benchmark's, not the column's.
    // Only a screen with no numbers on it calls nobody and costs nothing.
    const floor = await auditFloor(
      runFloor({ world: scoped, artifact, blocking: outcome?.blocking ?? [], trace, shot }),
      scoped,
      shot?.visibleText ?? "",
    );

    // Outside the contender's budget: the wait is the grader's, and charging it
    // to the column would report a timeout the contender never had. `judge`
    // owns its own retries and never throws, so a judge having a bad afternoon
    // lands as a degraded verdict rather than a lost case.
    const judged =
      shot === undefined
        ? ungraded(testCase.pass, scoped.style)
        : await judge({
            screenshot: shot.png,
            artifact: artifact ?? "",
            trace,
            caseLines: testCase.pass,
            styleLines: scoped.style,
          });

    const failure = broke ?? outcome?.failure;
    const nodes = nodesOf(outcome?.payload);
    const result: CaseResult = {
      run: runId,
      contender: contender.slug,
      model: modelId,
      case: testCase.id,
      prompt: testCase.prompt,
      lane: testCase.lane,
      floor,
      timing: {
        ...(outcome?.firstRenderMs === undefined ? {} : { firstRenderMs: outcome.firstRenderMs }),
        settledMs: outcome?.settledMs ?? meter.elapsedMs(),
      },
      // The meter is every column's clock, but not every column's bill: a
      // contender that spawns its own engine reports what that session spent,
      // priced through the same table (`usdFor`).
      cost: { usage: outcome?.usage ?? meter.totals(), usd: outcome?.usd ?? meter.usd() },
      islands: nodes.filter((node) => node.source === "generated").length,
      clientOnly: nodes.filter((node) => node.component !== undefined && CHARTS.has(node.component)).length,
      trace,
      consoleErrors: shot?.consoleErrors ?? [],
      world: world.hash,
      caseHash: caseHash(testCase),
      judged,
      judgeContract: JudgeContract,
      ...(failure === undefined ? {} : { failure }),
    };
    await writeCase(runDir, { outcome, html: done?.html, shot, result });
    const scored = checks(floor);
    const audited = floor.honestData.audited ?? [];
    console.log(
      `· ${contender.slug} / ${testCase.id} · floor ${scored.filter((check) => check.pass).length}/${scored.length}` +
        ` · judged ${judged.degraded ? "—" : tally(judged.lines)}` +
        ` · ${result.timing.settledMs}ms · $${result.cost.usd.toFixed(4)}` +
        // A second model call is never silent: say what it was asked and what it
        // cleared, or the run's spend gains a line nobody can account for.
        (audited.length === 0
          ? ""
          : ` · audited ${audited.filter((one) => one.verdict === "cleared-by-audit").length}/${audited.length}`) +
        (floor.honestData.degraded === true ? ` · AUDITOR DEGRADED: ${floor.honestData.error ?? ""}` : "") +
        (judged.degraded ? ` · JUDGE DEGRADED: ${judged.error ?? ""}` : ""),
    );
    return result;
  };

  try {
    for (const testCase of cases) {
      const scoped = worldForCase(world, testCase);
      worlds[testCase.id] = scoped;
      // The whole row at once: they share only the browser, a page each, and the
      // order of `results` is the order of `contenders` whoever finishes first.
      const row = await Promise.all(
        contenders(args.models).map(async (contender) => await runOne(contender, testCase, scoped)),
      );
      results.push(...row);
    }
  } finally {
    await shooter.close();
  }

  const preview = await writePreview({ runDir, runId, results, worlds });
  console.log(preview);
  if (process.platform === "darwin" && shouldOpen(args, process.env)) {
    spawn("open", [preview], { detached: true, stdio: "ignore" }).unref();
  }
  const code = exitCode(results);
  // The verdict in words, last. `pnpm` prints its own ELIFECYCLE noise over a
  // non-zero exit, and the number that decided the run should not have to be
  // inferred from that.
  console.log(`floor failures: ${results.filter((result) => !result.floor.pass).length} (exit ${code})`);
  return code;
}

// Only when run as the command — importing this module from a test must not
// start a benchmark.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    },
  );
}
