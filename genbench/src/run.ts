import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { UIPayload } from "@vendoai/core";
import { execFileSync, spawn } from "node:child_process";
import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { auditFloor, AUDITOR_CONTRACT } from "./audit.js";
import { claudeCodeDriver, WALL_CLOCK_MS, type SessionRecord } from "./claude-code.js";
import { diyDriver } from "./diy.js";
import { checks, runFloor, type FloorResult } from "./floor.js";
import { judge, JudgeContract, rubricLines, type JudgeResult } from "./judge.js";
import {
  meteredModel,
  MODEL_IDS,
  WAFER_BASE_URL,
  WAFER_MODEL_IDS,
  type Meter,
  type ModelAlias,
  type UsageTotals,
} from "./meter.js";
import { probe, type Probed } from "./probe.js";
import { authoredPage, bundleMount, openBrowser, pageHtml, type Shot } from "./render.js";
import { tally, writePreview, writeSummary } from "./report.js";
import { TriageContract } from "./triage.js";
import { vendoDriver } from "./vendo.js";
import { caseHash, loadCases, loadWorld, worldForCase, type Case, type CaseShape, type Lane, type World } from "./world.js";

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
  /** The case's budget, already spent: this attempt has been recorded and
   *  nobody is waiting for it. Absent only where nothing races the driver,
   *  which is the tests. */
  readonly signal?: AbortSignal;
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
  /** What a contender that runs its own engine says about that session. */
  readonly session?: SessionRecord;
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
  readonly shape: CaseShape;
  /** The real screen the case was mined from, carried so the preview can say
   *  where the question came from. Absent for a case nobody mined. */
  readonly source?: string;
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
  /** The two pinned models the honesty check leaned on, stamped for the same
   *  reason the judge's is: a triage that waives on a different prompt, or an
   *  auditor that proves under a different one, is a different check and its
   *  `honestData` verdicts do not compare with another run's. */
  readonly triageContract: typeof TriageContract;
  readonly auditorContract: typeof AUDITOR_CONTRACT;
  /** What the provider says actually answered this column. `model` is the id we
   *  asked for, and two of the three are floating aliases (`meter.ts`). */
  readonly modelVersion?: string;
  /** The tree the harness itself was, and the engine version the `claude-code`
   *  column ran on. Both move under a run without any stamp moving, so two
   *  results that do not carry the same pair were not produced by the same
   *  benchmark. */
  readonly gitSha: string;
  readonly agentSdkVersion: string;
  /** A contender that runs its own engine, in that engine's own words. */
  readonly session?: SessionRecord;
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

const HARNESS_IDS = Object.keys(DRIVERS) as readonly HarnessId[];

/** The world a run uses when `--world` names none — one of the fourteen folders
 *  under `worlds/`. */
const DEFAULT_WORLD = "maple";

/** Every world, into one run folder. The corpus is 200 cases across fourteen
 *  worlds, and one number for the whole corpus cannot be read off fourteen
 *  disconnected run folders. */
const ALL_WORLDS = "all";

export interface Args {
  readonly only?: string;
  readonly models: readonly ModelAlias[];
  /** A folder under `worlds/`, holding `world.json`, `cases.json` and any face —
   *  or `all`, which is every folder there. */
  readonly world: string;
  /** The harnesses that race each case. Every driver, unless narrowed. */
  readonly contenders: readonly HarnessId[];
  /** How many cases are in flight at once. */
  readonly jobs: number;
}

export function parseArgs(argv: readonly string[]): Args {
  const rest = argv[0] === "run" ? argv.slice(1) : argv;
  let only: string | undefined;
  let models: readonly ModelAlias[] = ["sonnet"];
  let world = DEFAULT_WORLD;
  let harnesses = HARNESS_IDS;
  let jobs = 1;
  let index = 0;
  while (index < rest.length) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (value === undefined) throw new Error(`genbench: "${flag}" needs a value`);
    if (flag === "--prompt") only = value;
    else if (flag === "--models") models = value.split(",").map(asAlias);
    else if (flag === "--world") world = value;
    else if (flag === "--contenders") harnesses = value.split(",").map(asHarness);
    else if (flag === "--jobs") jobs = asJobs(value);
    else throw new Error(`genbench: unexpected argument "${flag}"`);
    index += 2;
  }
  return { ...(only === undefined ? {} : { only }), models, world, contenders: harnesses, jobs };
}

function asAlias(value: string): ModelAlias {
  if (!Object.hasOwn(MODEL_IDS, value)) throw new Error(`genbench: unknown model "${value}"`);
  return value as ModelAlias;
}

function asHarness(value: string): HarnessId {
  if (!Object.hasOwn(DRIVERS, value)) throw new Error(`genbench: unknown contender "${value}"`);
  return value as HarnessId;
}

function asJobs(value: string): number {
  const jobs = Number(value);
  if (!Number.isInteger(jobs) || jobs < 1) throw new Error(`genbench: --jobs takes whole cases, not "${value}"`);
  return jobs;
}

/** Every contender that has a driver today, in every model that driver can
 *  think with. Claude Code spawns its own Anthropic engine and never reads
 *  `meter.model`, so a Wafer alias would reach its Agent SDK as an Anthropic id
 *  and the column would report the harness's mistake as the model's score. */
export function contenders(
  models: readonly ModelAlias[],
  harnesses: readonly HarnessId[] = HARNESS_IDS,
): readonly ContenderId[] {
  return harnesses.flatMap((harness) =>
    models
      .filter((model) => harness !== "claude-code" || !Object.hasOwn(WAFER_MODEL_IDS, model))
      .map((model) => ({ harness, model, slug: `${harness}-${model}` })),
  );
}

/**
 * Up to `limit` jobs in flight, answering in the jobs' own order.
 *
 * Within a case the contenders already race each other; this is the bound
 * ACROSS cases, and it is a bound rather than `Promise.all` because every case
 * in flight holds a browser page, a model's rate limit and a share of the
 * laptop. The order is the order the cases were authored in, never the order
 * they finished, for the same reason the columns never shuffle.
 */
export async function pool<T>(jobs: readonly (() => Promise<T>)[], limit: number): Promise<T[]> {
  const done: T[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < jobs.length) {
      const index = next++;
      done[index] = await jobs[index]!();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
  return done;
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

/** The world folders one run covers: the one that was named, or every folder
 *  there. Fourteen worlds and 200 cases used to mean fourteen run folders and no
 *  total anywhere, so the question the benchmark exists to answer had nowhere to
 *  be answered. */
export async function worldsFor(worldsDir: string, world: string): Promise<readonly string[]> {
  if (world !== ALL_WORLDS) return [world];
  const entries = await readdir(worldsDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/**
 * What the harness itself was, read once at the start of a run.
 *
 * Both halves move under a benchmark without a single stamp in `result.json`
 * moving with them: the tree is the vendo column's whole product, and the Agent
 * SDK is the `claude-code` column's whole engine. Two results that do not carry
 * the same pair were not produced by the same benchmark, whatever their model
 * ids and rubric versions agree about.
 */
export async function harnessStamp(root: string): Promise<{ gitSha: string; agentSdkVersion: string }> {
  const sdk = createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk");
  const manifest = JSON.parse(await readFile(join(dirname(sdk), "package.json"), "utf8")) as { version: string };
  return {
    gitSha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    agentSdkVersion: manifest.version,
  };
}

async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey === undefined || apiKey === "") {
    console.error("genbench: ANTHROPIC_API_KEY is not set");
    return 1;
  }
  // Demanded up front rather than at the first call, which is a case and a
  // browser later. The Anthropic key is still required whatever was asked for:
  // the judge and the honesty check run on it, whoever built the screen.
  const waferKey = process.env.WAFER_API_KEY;
  const wanted = args.models.filter((alias) => Object.hasOwn(WAFER_MODEL_IDS, alias));
  if (wanted.length > 0 && (waferKey === undefined || waferKey === "")) {
    console.error(`genbench: WAFER_API_KEY is not set, and it is what serves ${wanted.join(", ")}`);
    return 1;
  }

  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const worldsDir = join(root, "worlds");
  const names = await worldsFor(worldsDir, args.world);

  const runId = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const runDir = join(root, "runs", runId);
  const anthropic = createAnthropic({ apiKey });
  const wafer = createOpenAICompatible({ name: "wafer", baseURL: WAFER_BASE_URL, apiKey: waferKey });
  const bundle = await bundleMount();
  const shooter = await openBrowser();
  const results: CaseResult[] = [];
  /** The world each case was actually graded against — what the report's data
   *  panel shows, so a person can check any number on any screen against it. */
  const worlds: Record<string, World> = {};
  const stamp = await harnessStamp(root);

  /** One column of one case, start to finish, reporting rather than throwing.
   *  `key` is the case's own id, or `<world>/<id>` where a run covers more than
   *  one world — two worlds really do ship a `visit-history`, and one run folder
   *  would otherwise write both into the same directory. */
  const runOne = async (contender: ContenderId, testCase: Case, scoped: World, key: string): Promise<CaseResult> => {
    const modelId = MODEL_IDS[contender.model];
    // Its own meter, so a sibling's tokens and a sibling's clock are never
    // charged to this column.
    const provider = Object.hasOwn(WAFER_MODEL_IDS, contender.model) ? wafer : anthropic;
    const meter = meteredModel(provider(modelId), modelId);

    /** Evidence as it is produced, not as it is returned. Losing the outer race
     *  used to discard a screenshot that had already been taken and a trace that
     *  had already been recorded, so a case that ran out of time was graded as
     *  a screen that failed every check — the harness's clock reported as the
     *  contender's quality. Whatever exists is graded; the timeout is recorded
     *  beside it as itself. */
    const captured: { outcome?: RunOutcome; html?: string; shot?: Shot; trace?: Probed[] } = {};

    // Raced against the clock as one unit: generation, paint and probe all spend
    // the person's wait, so one budget covers all three.
    const { failure: broke } = await attempt(async (lost) => {
      captured.outcome = await DRIVERS[contender.harness](contender.model).run({
        world: scoped,
        testCase,
        meter,
        signal: lost,
      });
      // Either the product compiled a payload into a page, or the contender
      // handed over an artifact that already IS a document. From here on both
      // are just a page.
      const outcome = captured.outcome;
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
      if (html === undefined || lost.aborted) return;
      captured.html = html;
      const visit = await shooter.visit(html);
      try {
        captured.shot = await visit.shot();
        captured.trace = await probe(visit);
      } finally {
        await visit.close();
      }
    }, CASE_TIMEOUT_MS[contender.harness]);

    // Read out before anything else is awaited: work that lost the race is still
    // running and still writing into `captured`.
    const { outcome, html: page, shot, trace = [] } = captured;
    const artifact = outcome?.artifact;
    // The fabrication check's verdict — every claim on the screen answered for
    // by a program the harness ran — and outside the contender's budget for the
    // same reason the judge is: the wait is the benchmark's, not the column's. A
    // screen whose every number the tools already answer with calls nobody and
    // costs nothing.
    const floor = await auditFloor(
      runFloor({
        world: scoped,
        artifact,
        blocking: outcome?.blocking ?? [],
        trace,
        shot,
        tags: testCase.tags ?? [],
      }),
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
            // The RENDERED DOM, for every column. Vendo's artifact is a TSX
            // document and both baselines' is HTML, so sending each column its
            // own artifact handed the judge a perfect classifier for which one
            // was the vendor's — under a prompt that says the format is not
            // evidence. Sending the page FILE instead fixed that and lost the
            // column anyway: vendo's inlines the whole runtime, so its every
            // case died at `prompt is too long`. What the browser holds once
            // the screen settled is one format for everyone and small with it.
            artifact: shot.dom,
            trace,
            caseLines: testCase.pass,
            styleLines: scoped.style,
            caseHash: caseHash(testCase),
          });

    const failure = broke ?? outcome?.failure;
    const nodes = nodesOf(outcome?.payload);
    const result: CaseResult = {
      run: runId,
      contender: contender.slug,
      model: modelId,
      case: key,
      prompt: testCase.prompt,
      lane: testCase.lane,
      shape: testCase.shape,
      source: testCase.source,
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
      world: scoped.hash,
      caseHash: caseHash(testCase),
      judged,
      judgeContract: JudgeContract,
      triageContract: TriageContract,
      auditorContract: AUDITOR_CONTRACT,
      ...(meter.answeredBy() === undefined ? {} : { modelVersion: meter.answeredBy()! }),
      ...stamp,
      ...(outcome?.session === undefined ? {} : { session: outcome.session }),
      ...(failure === undefined ? {} : { failure }),
    };
    await writeCase(runDir, { outcome, html: page, shot, result });
    const scored = checks(floor);
    const values = floor.honestData.audited ?? [];
    const waived = values.filter((one) => one.verdict === "skipped-by-triage").length;
    const cleared = values.filter((one) => one.verdict.startsWith("cleared")).length;
    console.log(
      `· ${contender.slug} / ${key} · floor ${scored.filter((check) => check.pass).length}/${scored.length}` +
        ` · judged ${judged.degraded ? "—" : tally(judged.lines)}` +
        ` · ${result.timing.settledMs}ms · $${result.cost.usd.toFixed(4)}` +
        // The honesty check's own model calls are never silent: say what it was
        // asked, what it cleared and what it waived, or the run's spend gains a
        // line nobody can account for and a waiver nobody notices.
        (values.length === 0
          ? ""
          : ` · values ${cleared}/${values.length - waived}` + (waived === 0 ? "" : ` · ${waived} waived`)) +
        (floor.honestData.degraded === true ? ` · HONESTY DEGRADED: ${floor.honestData.error ?? ""}` : "") +
        (judged.degraded ? ` · JUDGE DEGRADED: ${judged.error ?? ""}` : ""),
    );
    return result;
  };

  try {
    // Every case as a job first, then up to `--jobs` of them at once. The worlds
    // are read here, in one pass and in order, so nothing a case is graded
    // against depends on which cases happened to be in flight beside it.
    const cases: (() => Promise<CaseResult[]>)[] = [];
    for (const name of names) {
      const worldDir = join(worldsDir, name);
      const world = await loadWorld(worldDir);
      const all = await loadCases(join(worldDir, "cases.json"));
      for (const testCase of all.filter((entry) => args.only === undefined || entry.id === args.only)) {
        const key = names.length === 1 ? testCase.id : `${name}/${testCase.id}`;
        const scoped = worldForCase(world, testCase);
        worlds[key] = scoped;
        // The whole row at once: they share only the browser, a page each, and the
        // order of `results` is the order of `contenders` whoever finishes first.
        cases.push(
          async () =>
            await Promise.all(
              contenders(args.models, args.contenders).map(
                async (contender) => await runOne(contender, testCase, scoped, key),
              ),
            ),
        );
      }
    }
    results.push(...(await pool(cases, args.jobs)).flat());
  } finally {
    await shooter.close();
  }
  if (results.length === 0) throw new Error(`genbench: no case matches --prompt "${args.only ?? ""}"`);

  const summary = await writeSummary({ runDir, runId, results, gitSha: stamp.gitSha });
  console.log(summary);
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
