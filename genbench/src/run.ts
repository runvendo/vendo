import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { UIPayload } from "@vendoai/core";
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, link, readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { claudeCodeDriver, WALL_CLOCK_MS as CLAUDE_CODE_WALL_CLOCK_MS, type SessionRecord } from "./claude-code.js";
import { codexDriver, WALL_CLOCK_MS as CODEX_WALL_CLOCK_MS } from "./codex.js";
import { diyDriver } from "./diy.js";
import { checks, runFloor, type FloorResult } from "./floor.js";
import { unadjudicated, type HonestyVerdict } from "./honesty.js";
import { judge, JudgeContract, rubricLines, type JudgeOptions, type JudgeResult } from "./judge.js";
import { liveness, type LivenessOptions, type LivenessResult } from "./liveness.js";
import {
  CODEX_MODEL_IDS,
  meteredModel,
  MODEL_IDS,
  OPENROUTER_MODEL_IDS,
  THESYS_MODEL_IDS,
  WAFER_BASE_URL,
  WAFER_MODEL_IDS,
  type Meter,
  type ModelAlias,
  type UsageTotals,
} from "./meter.js";
import { probe, type Probed } from "./probe.js";
import { authoredPage, bundleMount, openBrowser, pageHtml, type Shooter, type Shot } from "./render.js";
import { tally, writePreview, writeSummary, type RunSummary } from "./report.js";
import { thesysDriver, thesysProvider } from "./thesys.js";
import { vendoDriver, type Pipeline } from "./vendo.js";
import { cannedResponse, caseHash, loadCases, loadWorld, worldForCase, type Case, type CaseShape, type Lane, type World } from "./world.js";

export type HarnessId = "vendo" | "diy" | "claude-code" | "thesys" | "codex";

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
  /** The case's budget, spent — with {@link SALVAGE_MS} of the case's clock
   *  still left to hand something over. A driver that can answer it stops
   *  waiting and reports what it ALREADY has, which is graded like any other
   *  screen; one that cannot is recorded as a timeout with nothing. Absent only
   *  where nothing races the driver, which is the tests. */
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
  /** What the contender's OWN reviewer said on the way to this screen. Only the
   *  product has one, so only that column reports it. */
  readonly pipeline?: Pipeline;
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
  /** Whether this screen is BOUND to the host's data or merely decorated with
   *  it: the data under the saved page is moved and the page painted again, and
   *  this is how many of the values it showed moved with it (`liveness.ts`).
   *  REPORTED, never gated — `floor.pass`, the exit code and every existing
   *  score are blind to it. Absent where no page was ever painted, and for every
   *  run recorded before the axis existed; `genbench liveness <run folder>`
   *  fills those in, spending one small call per stale accusation and nothing at
   *  all on a screen that has none. */
  readonly liveness?: LivenessResult;
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
  /** The contender's OWN review of this screen before anyone else graded it, and
   *  whether it painted again after — the only way to tell a defect the product's
   *  reviewer never mentioned from one it named and failed to repair. Only the
   *  vendo column has an internal reviewer, so only it carries this. */
  readonly pipeline?: Pipeline;
  readonly failure?: string;
}

/** Declaration order is column order — the report never sorts by who finished
 *  first. Every driver takes the model its column was asked for; the two that
 *  are metered by the run read it off `meter.model` instead and ignore it. */
const DRIVERS: Record<HarnessId, (model: ModelAlias) => Contender> = {
  vendo: vendoDriver,
  diy: diyDriver,
  "claude-code": (model) => claudeCodeDriver({ model }),
  thesys: thesysDriver,
  codex: (model) => codexDriver({ model }),
};

const HARNESS_IDS = Object.keys(DRIVERS) as readonly HarnessId[];

/** The world a run uses when `--world` names none — one of the fourteen folders
 *  under `worlds/`. */
const DEFAULT_WORLD = "maple";

/** Every world, into one run folder. The corpus is 200 cases across fourteen
 *  worlds, and one number for the whole corpus cannot be read off fourteen
 *  disconnected run folders. */
const ALL_WORLDS = "all";

/** What `--contenders` takes: a bare harness, crossed with every `--models`
 *  alias, or one pinned `harness:model` pair, which is exactly that column and
 *  nothing else. The matrix stopped being a rectangle once some columns had a
 *  model line of their own — naming a model to get one column of it also crossed
 *  that model onto every other harness in the list. */
export type Column = HarnessId | { readonly harness: HarnessId; readonly model: ModelAlias };

/**
 * The row a bare `genbench run` races: every contender once, each on the model
 * its column is bought for, and all of them in ONE price band — Sonnet 5, GPT-5.6
 * Terra and Gemini 3.1 Pro list within a dollar of each other. A flagship set
 * against another vendor's mid-tier measures a price tag rather than a product,
 * and this benchmark exists to answer buy versus build. `--contenders` is still
 * the door to anything else, the flagships included.
 *
 * Pairs rather than bare harnesses, because the matrix is not a rectangle: every
 * column here names its own model, and crossing `--models` over the row would
 * hand `diy` the same Sonnet 5 twice — once first-party, once through the router.
 * Declaration order is column order, the same doctrine as `DRIVERS`.
 */
const DEFAULT_MATRIX: readonly Column[] = [
  { harness: "vendo", model: "sonnet" },
  { harness: "diy", model: "claude" },
  { harness: "diy", model: "gpt" },
  { harness: "diy", model: "gemini" },
  { harness: "claude-code", model: "sonnet" },
  { harness: "thesys", model: "c1" },
  { harness: "codex", model: "terra" },
];

export interface Args {
  readonly only?: string;
  readonly models: readonly ModelAlias[];
  /** A folder under `worlds/`, holding `world.json`, `cases.json` and any face —
   *  or a comma list of them, or `all`, which is every folder there. */
  readonly world: string;
  /** The columns that race each case: {@link DEFAULT_MATRIX} unless narrowed. */
  readonly contenders: readonly Column[];
  /** How many cases are in flight at once. */
  readonly jobs: number;
  /** Generate, paint, probe and score the mechanical floor — and ask no judge.
   *  The cheap sweep: a floor is deterministic and local, so it can be run over
   *  every world after a landing without spending a grader on verdicts nobody
   *  is asking to change. */
  readonly floorOnly: boolean;
}

export function parseArgs(argv: readonly string[]): Args {
  const rest = argv[0] === "run" ? argv.slice(1) : argv;
  let only: string | undefined;
  let models: readonly ModelAlias[] = ["sonnet"];
  let world = DEFAULT_WORLD;
  let columns: readonly Column[] = DEFAULT_MATRIX;
  let jobs = 1;
  let floorOnly = false;
  let index = 0;
  while (index < rest.length) {
    const flag = rest[index];
    // The one argument that takes no value, because it names a MODE rather than
    // a number: the judge is asked or it is not.
    if (flag === "--floor-only") {
      floorOnly = true;
      index += 1;
      continue;
    }
    const value = rest[index + 1];
    if (value === undefined) throw new Error(`genbench: "${flag}" needs a value`);
    if (flag === "--prompt") only = value;
    else if (flag === "--models") models = value.split(",").map(asAlias);
    else if (flag === "--world") world = value;
    else if (flag === "--contenders") columns = value.split(",").map(asColumn);
    else if (flag === "--jobs") jobs = asJobs(value);
    else throw new Error(`genbench: unexpected argument "${flag}"`);
    index += 2;
  }
  return { ...(only === undefined ? {} : { only }), models, world, contenders: columns, jobs, floorOnly };
}

function asAlias(value: string): ModelAlias {
  if (!Object.hasOwn(MODEL_IDS, value)) throw new Error(`genbench: unknown model "${value}"`);
  return value as ModelAlias;
}

function asHarness(value: string): HarnessId {
  if (!Object.hasOwn(DRIVERS, value)) throw new Error(`genbench: unknown contender "${value}"`);
  return value as HarnessId;
}

function asColumn(value: string): Column {
  const [harness, ...model] = value.split(":");
  // Everything after the first colon is the model, so `a:b:c` is refused as the
  // model `b:c` rather than silently run as `a:b`.
  return model.length === 0 ? asHarness(value) : { harness: asHarness(harness!), model: asAlias(model.join(":")) };
}

function asJobs(value: string): number {
  const jobs = Number(value);
  if (!Number.isInteger(jobs) || jobs < 1) throw new Error(`genbench: --jobs takes whole cases, not "${value}"`);
  return jobs;
}

/** The harnesses that are a PRODUCT rather than a harness over a model — the
 *  vendor picks it, not us. Each runs its own aliases and nothing else, and no
 *  other column may run one of those: they only resolve at that vendor's
 *  endpoint or inside that vendor's CLI. */
const EXCLUSIVE: ReadonlyArray<readonly [HarnessId, Readonly<Record<string, string>>]> = [
  ["thesys", THESYS_MODEL_IDS],
  ["codex", CODEX_MODEL_IDS],
];

/**
 * The one column that borrows a product's alias: the vendo pipeline thinking
 * with the codex column's model.
 *
 * Every other pair of columns changes the harness AND the model at once, so the
 * gap between them says nothing about which of the two moved. `vendo:terra`
 * beside `codex:terra` — and beside `vendo:sonnet` — is the same pipeline on two
 * models and the same model under two pipelines, which is the only shape that
 * separates the product from what it thinks with.
 *
 * It borrows the alias and not the door: the CLI is billed by OpenAI's platform
 * and this column is not, so the two are priced where each really ran
 * ({@link door}).
 */
const BORROWED = "vendo:terra";

/** Whether this harness may think with this model at all. Claude Code spawns its
 *  own Anthropic engine and never reads `meter.model`, so a Wafer alias would
 *  reach its Agent SDK as an Anthropic id and the column would report the
 *  harness's mistake as the model's score. The router's aliases are the
 *  cross-VENDOR row and stay on `diy`, the one column that is nothing but a
 *  model call, which is what makes three vendors comparable at all; anywhere
 *  else they would double a column that already exists first-party, since
 *  `anthropic/claude-sonnet-5` is the `sonnet` column with a middleman in
 *  front. The exclusivity above holds everywhere except the one borrowed
 *  column, which is a column and not a rule. */
const runs = (harness: HarnessId, model: ModelAlias): boolean =>
  (`${harness}:${model}` === BORROWED ||
    EXCLUSIVE.every(([owner, ids]) => Object.hasOwn(ids, model) === (harness === owner))) &&
  (harness !== "claude-code" || !Object.hasOwn(WAFER_MODEL_IDS, model)) &&
  (harness === "diy" || !Object.hasOwn(OPENROUTER_MODEL_IDS, model));

/**
 * The provider a column's model answers at, and the id it answers under.
 *
 * One decision and not two: an alias only means anything at a door, and the
 * meter prices what the WIRE answered rather than what the column was called.
 * The borrowed column is why both halves have to move together — `terra` is
 * OpenAI's own `gpt-5.6-terra` inside the codex CLI, billed to the platform
 * account at OpenAI's list rate, and no provider built here can reach that id at
 * all: the first-party endpoint refuses the `max_tokens` every OpenAI-compatible
 * client sends. So a harness that builds its own provider goes through the
 * router, where the same model is `openai/gpt-5.6-terra` — a different id, the
 * same list rate, and `PRICING` already carries both rows.
 *
 * A column that spawns its own engine (`claude-code`, `codex`) never calls what
 * this answers with; the model is built and left unused, and only the id
 * matters, as the stamp on the result and the row its own session is priced by.
 */
export function door(contender: ContenderId): {
  readonly at: "anthropic" | "wafer" | "thesys" | "openrouter";
  readonly modelId: string;
} {
  const { harness, model } = contender;
  if (`${harness}:${model}` === BORROWED) return { at: "openrouter", modelId: OPENROUTER_MODEL_IDS.gpt };
  const modelId = MODEL_IDS[model];
  if (Object.hasOwn(WAFER_MODEL_IDS, model)) return { at: "wafer", modelId };
  if (Object.hasOwn(THESYS_MODEL_IDS, model)) return { at: "thesys", modelId };
  if (Object.hasOwn(OPENROUTER_MODEL_IDS, model)) return { at: "openrouter", modelId };
  return { at: "anthropic", modelId };
}

/** Every contender that has a driver today, in every model that driver can think
 *  with — except where a column was named as a `harness:model` pair, which is
 *  that one column and skips the cross. Either way the rules above decide, so a
 *  pair cannot ask for a column the matrix would never have produced.
 *
 *  The default here is that whole cross, which is what a bare harness in
 *  `--contenders` means. A bare RUN is `DEFAULT_MATRIX`, which `parseArgs`
 *  supplies. */
export function contenders(
  models: readonly ModelAlias[],
  columns: readonly Column[] = HARNESS_IDS,
): readonly ContenderId[] {
  const row = columns.flatMap((column) => {
    const harness = typeof column === "string" ? column : column.harness;
    return (typeof column === "string" ? models : [column.model])
      .filter((model) => runs(harness, model))
      .map((model) => ({ harness, model, slug: `${harness}-${model}` }));
  });
  if (row.length === 0) {
    // Named back the way it was asked for, pairs included, or the sentence
    // cannot say which pairing emptied the row.
    const asked = columns.map((column) => (typeof column === "string" ? column : `${column.harness}:${column.model}`));
    throw new Error(
      `genbench: ${asked.join(", ")} has no column for ${models.join(", ")} — name an Anthropic model, or another contender`,
    );
  }
  // By slug, because the slug IS the column: it names the evidence directory and
  // the report column, so `vendo,vendo:sonnet` has to be one column asked for
  // twice rather than two contenders racing to overwrite one folder and be
  // counted twice in the summary. The Map keeps the position of the first
  // mention, which is the same doctrine as declaration order being column order.
  return [...new Map(row.map((contender) => [contender.slug, contender])).values()];
}

/**
 * The first key the resolved row needs and has not been given, in words.
 *
 * Demanded up front rather than at the first call, which is a case and a browser
 * later. Keyed off the ROW and not off `--models`, because narrowing
 * `--contenders` drops columns: `--models sonnet,c1 --contenders vendo` runs no
 * thesys column, and demanding its key would fail a run that never needed it.
 * The Anthropic key is not in this table — the judge and the honesty check run
 * on it whoever built the screen, so it is required whatever was asked for.
 *
 * Read off the DOOR rather than the alias, because one alias can have two: the
 * borrowed column reaches `terra` through the router and owes the router's key,
 * while the codex column reaches the same alias inside a CLI and owes OpenAI's.
 * That last one is the harness's key and not a door's — `codex` opens none here.
 */
export function missingKey(row: readonly ContenderId[], env: NodeJS.ProcessEnv): string | undefined {
  for (const [name, serves] of [
    ["WAFER_API_KEY", (contender: ContenderId) => door(contender).at === "wafer"],
    ["THESYS_API_KEY", (contender: ContenderId) => door(contender).at === "thesys"],
    ["OPENROUTER_API_KEY", (contender: ContenderId) => door(contender).at === "openrouter"],
    ["OPENAI_API_KEY", (contender: ContenderId) => contender.harness === "codex"],
  ] as const) {
    const wanted = [...new Set(row.filter(serves).map(({ model }) => model))];
    if (wanted.length > 0 && (env[name] ?? "") === "") {
      return `genbench: ${name} is not set, and it is what serves ${wanted.join(", ")}`;
    }
  }
  return undefined;
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
  const failures: unknown[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < jobs.length) {
      const index = next++;
      // A job that throws loses ITSELF, after every other job has run — a
      // rejection that surfaced mid-pool tore the shared browser out from
      // under every case still in flight (2026-08-19, 17 cases and the
      // summary lost to one liveness timeout). "A column that dies takes
      // down nothing but itself" is the whole file's doctrine, and the pool
      // has to keep it too.
      try {
        done[index] = await jobs[index]!();
      } catch (error) {
        failures.push(error);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
  if (failures.length > 0) throw failures[0];
  return done;
}

/** The recharts-backed Kit components (packages/ui/src/kit/charts/). */
const CHARTS = new Set(["LineChart", "BarChart", "DonutChart", "Sparkline"]);

/**
 * One contender's whole budget for one case — generation, paint and probe.
 *
 * Per harness rather than one number for the row: an agentic build runs its own
 * ten-minute wall clock (`WALL_CLOCK_MS`, one per agentic driver) before it has
 * delivered anything, so a five-minute case would end it early and record a
 * timeout the contender never had. The one-call columns keep the tighter bound
 * they have never needed more than.
 */
export const CASE_TIMEOUT_MS: Readonly<Record<HarnessId, number>> = {
  vendo: 5 * 60_000,
  diy: 5 * 60_000,
  "claude-code": CLAUDE_CODE_WALL_CLOCK_MS + 2 * 60_000,
  thesys: 5 * 60_000,
  codex: CODEX_WALL_CLOCK_MS + 2 * 60_000,
};

/**
 * How long before the end of a case's budget the contender is told it is over.
 *
 * A painted screen at the cap is a real screen, and throwing it away graded the
 * harness's clock as the contender's quality: one timed-out case had painted and
 * saved several times before the bell, and every rubric line on it was failed
 * for a screen that existed. So the signal fires early enough for a driver to
 * hand back what it already has — and that screen still has to be painted and
 * pressed, so the window is CARVED OUT of the case's clock rather than added to
 * it: `CASE_TIMEOUT_MS` stays the whole case, generation, paint and probe. Sized
 * to `render.ts`'s own settle bound, the one wait a salvaged screen cannot skip.
 */
export const SALVAGE_MS = 30_000;

/**
 * One contender's whole attempt as a settled value.
 *
 * Its own crash and its own silence become results here, never exceptions, so
 * the row can be gathered with `Promise.all`: a column that dies takes down
 * nothing but itself, and every column keeps its place.
 *
 * Losing the race does not STOP the work — nothing here can reach inside a
 * driver mid-generation — so the work is handed two signals, and they say
 * different things. `spent` says the budget is gone and whatever you have is
 * what this case gets, which is a driver's cue to stop waiting on itself and
 * report its last painted screen. `lost` says the case has been RECORDED and
 * nobody is waiting at all, which is the one that matters for the shared
 * browser: a column that walks on past it would otherwise open a page on the
 * browser a case or two later, with nobody looking at what it shows.
 */
export async function attempt<T>(
  work: (lost: AbortSignal, spent: AbortSignal) => Promise<T>,
  budgetMs: number,
): Promise<{ done?: T; failure?: string }> {
  const lost = new AbortController();
  const spent = new AbortController();
  setTimeout(() => spent.abort(), Math.max(budgetMs - SALVAGE_MS, 0)).unref();
  return await Promise.race([
    work(lost.signal, spent.signal).then(
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
 * The run outlives its zombies.
 *
 * Losing the race does not STOP the work, so a driver runs on to its own finish
 * and can reject into nobody's hands long after its case was recorded: a
 * timed-out vendo case's audit write landed in the store its own driver had
 * since closed, and node killed the process for the unhandled rejection — with
 * 38 other cases already on disk and `summary.json` never written. A benchmark
 * runner survives that. One column's late throw is no more allowed to end the
 * run than its crash is ({@link attempt}), and the row is what is being measured.
 *
 * Never quiet: every survival prints one line, with the stack and whatever was
 * in flight when it landed. A rejection nobody reads is a finding nobody has.
 */
export function surviveLateFailures(inFlight: ReadonlySet<string>): void {
  process.on("unhandledRejection", (reason: unknown) => {
    console.error(
      `genbench: LATE FAILURE from work whose case is already recorded — the run continues.` +
        ` In flight: ${[...inFlight].join(", ") || "nothing"}\n` +
        (reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)),
    );
  });
}

/**
 * The rubric for a column that produced no screen: every line failed.
 *
 * That is the CONTENDER failing, not the judge, so it is not degraded and no
 * judge call is spent on a screenshot that does not exist. Graded rather than
 * skipped, because a column that quietly drops out of the rubric is a benchmark
 * that flatters whoever crashed.
 *
 * The honesty line fails here with the rest, and nothing accused it: there is no
 * screen, so there are no figures to audit and no check to open. Said out loud on
 * the record rather than left to an absence — three of run 2026-08-18T18-47-44's
 * honesty fails came out of here, `vendo-sonnet/subscription-billing/
 * renewal-schedule` among them, and every one of the three sat in its folder as a
 * fail with nothing beside it (`unadjudicated` in `honesty.ts`).
 */
export const ungraded = (caseLines: readonly string[], styleLines: readonly string[]): JudgeResult => {
  const note = "no screen was delivered to grade";
  return {
    lines: rubricLines(caseLines, styleLines).map((entry) => ({ ...entry, verdict: "fail" as const, note })),
    degraded: false,
    honesty: unadjudicated(note, "no screen was delivered, so this screen displayed no figures to audit"),
  };
};

/**
 * The rubric for a run that never bought one: no lines at all.
 *
 * `--floor-only` skips the judge, so there are no verdicts — and an EMPTY
 * rubric is the honest shape for that. It is not {@link ungraded}, which fails
 * every line because the contender delivered nothing, and it is not a degraded
 * judgement, which fails every line because the grader was unwell: both are
 * findings about a column, while a skipped exam is a fact about the run. The
 * report already reads it as one — no half is tallied, no line is counted as a
 * fail anywhere, and the preview says floor-only where the verdicts would be.
 */
export const unjudged: JudgeResult = { lines: [], degraded: false };

/** What the independent check made of a judge's honesty fail, in a word — said
 *  out loud because the tally beside it no longer shows the fail it overturned,
 *  and because a check that is quietly unreachable would otherwise leave every
 *  such fail standing with nothing saying why (`honesty.ts`). */
const SAID_HONESTY: Readonly<Record<HonestyVerdict, string>> = {
  none: "fail overturned",
  invented: "fail upheld",
  unadjudicated: "fail unadjudicated",
};

/** One column's rubric in a word, for the terminal: the tally, or a dash where
 *  there is no exam to report — a judge that could not grade, and a run that
 *  never asked one. */
const saidJudged = (judged: JudgeResult): string => {
  const said = judged.degraded || judged.lines.length === 0 ? "—" : tally(judged.lines);
  return judged.honesty === undefined ? said : `${said} · honesty ${SAID_HONESTY[judged.honesty.verdict]}`;
};

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

/** A wide table's picture, by its place on the screen: `table-1.png`. Written by
 *  the run, read back by a re-score, linked on by `carry` — one spelling for all
 *  three, and the pattern that finds them again is `TABLE_SHOT` below. */
const tableShot = (index: number): string => `table-${index + 1}.png`;

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
  if (wrote.shot !== undefined) {
    await writeFile(join(caseDir, "screenshot.png"), wrote.shot.png);
    // One picture per table the screen can only show by scrolling sideways,
    // beside the shot they belong to and numbered in the order they appear on it.
    // The judge is shown them (`wideTables` in `render.ts`), so a re-score has to
    // find them again — which is what names them here rather than in the loop.
    for (const [index, table] of wrote.shot.tables.entries()) {
      await writeFile(join(caseDir, tableShot(index)), table);
    }
    // The judge's OTHER channel, saved beside the picture it was shown: the DOM
    // the browser held once the screen settled. Without it a re-score has to
    // paint `page.html` in a browser again just to read back what the shot
    // already knew (`regrade`), and the whole point of a saved run is that the
    // screens do not have to be made twice.
    await writeFile(join(caseDir, "dom.html"), wrote.shot.dom);
  }
  await writeFile(join(caseDir, "result.json"), `${JSON.stringify(wrote.result, null, 2)}\n`);
}

/** A run folder's name: the second it started, in the one spelling `run` and
 *  `regrade` both stamp their folders with. */
const stampedNow = (): string => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

/** The ground truth behind a screen, as the judge is shown it: every response
 *  this case's tools answer with, overrides applied. The standing honesty line
 *  is graded against it, so a re-score has to build it the same way a run does —
 *  one spelling, both callers, and the tests that replay a saved case. */
export const toolData = (world: World): string =>
  world.tools.map((tool) => `${tool.name} → ${JSON.stringify(cannedResponse(tool))}`).join("\n");

/** The world folders one run covers: the ones that were named, or every folder
 *  there. Fourteen worlds and 200 cases used to mean fourteen run folders and no
 *  total anywhere, so the question the benchmark exists to answer had nowhere to
 *  be answered. */
export async function worldsFor(worldsDir: string, world: string): Promise<readonly string[]> {
  // Unique and first-seen, because the folder name IS the evidence key:
  // `maple,maple` wrote every contender's `maple/<case>` twice, the second pass
  // replacing the first's artifacts while both counted in the summary. `all`
  // anywhere in the list takes the whole corpus, which is why it needs no dedupe
  // of its own: it already contains every name written beside it.
  const named = [...new Set(world.split(","))];
  if (!named.includes(ALL_WORLDS)) return named;
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

// ---------------------------------------------------------------- re-scoring

export interface RegradeArgs {
  /** The run folder to re-score, as it is on disk. */
  readonly runDir: string;
  /** Cases in flight at once, exactly as a run's. */
  readonly jobs: number;
}

/** What every pass over a SAVED run takes: the folder — positional, because it
 *  is the whole argument — and the run's own `--jobs`, since a case at a time is
 *  still a queue whether the queue spends a judge call or a browser page.
 *  `regrade` and `liveness` differ in what they spend, never in what they take,
 *  so they parse through one reader and bring their own sentence for the empty
 *  command line. */
function parseFolderPass(argv: readonly string[], needs: string): { runDir: string; jobs: number } {
  const [runDir, ...rest] = argv;
  if (runDir === undefined) throw new Error(`genbench: ${needs}`);
  let jobs = 1;
  for (let index = 0; index < rest.length; index += 2) {
    const value = rest[index + 1];
    if (rest[index] !== "--jobs") throw new Error(`genbench: unexpected argument "${rest[index]}"`);
    if (value === undefined) throw new Error(`genbench: "--jobs" needs a value`);
    jobs = asJobs(value);
  }
  return { runDir: resolve(runDir), jobs };
}

/** `regrade <run folder>`, and the run's own `--jobs`. */
export const parseRegrade = (argv: readonly string[]): RegradeArgs =>
  parseFolderPass(argv, "regrade needs the run folder to re-score");

/** Every world folder as it is on disk TODAY, loaded once. A saved result names
 *  its world with a hash and never with a name, so this is what a stamp is
 *  matched against. */
async function corpusOnDisk(worldsDir: string): Promise<ReadonlyArray<{ world: World; cases: readonly Case[] }>> {
  return await Promise.all(
    (await worldsFor(worldsDir, ALL_WORLDS)).map(async (name) => ({
      world: await loadWorld(join(worldsDir, name)),
      cases: await loadCases(join(worldsDir, name, "cases.json")),
    })),
  );
}

/**
 * The world and the case a saved result was built against, as they are today —
 * and nothing at all when either has moved since.
 *
 * A result carries two stamps and no names: `world` is the world folder's
 * content hash and `caseHash` is the case as authored, while the only name it
 * has is the case key, which is `<world>/<id>` where the run covered more than
 * one world and a bare `<id>` where it did not. So the case is found by its id
 * and SETTLED by its stamps — which is the check a re-score has to pass anyway.
 * A screen built against a product that has since changed cannot be graded
 * against today's tool data: doing it silently would report the edit as the
 * contender's score.
 */
export function sourceOf(
  saved: Pick<CaseResult, "case" | "world" | "caseHash">,
  corpus: ReadonlyArray<{ world: World; cases: readonly Case[] }>,
): { world: World; testCase: Case } | undefined {
  const id = saved.case.split("/").at(-1);
  for (const { world, cases } of corpus) {
    const testCase = cases.find((entry) => entry.id === id);
    // Not `return` on the id alone: two worlds really do ship a `visit-history`,
    // and a bare case key does not say which one this was.
    if (testCase !== undefined && world.hash === saved.world && caseHash(testCase) === saved.caseHash) {
      return { world: worldForCase(world, testCase), testCase };
    }
  }
  return undefined;
}

/** What a re-score did not change, into the new folder: LINKED rather than
 *  copied, because a regraded corpus would otherwise put a second copy of every
 *  page and every picture on disk for verdicts that are the only new thing in
 *  it. A filesystem that will not link gets the copy. */
const EVIDENCE = ["artifact.tsx", "page.html", "screenshot.png", "dom.html"] as const;

/** {@link tableShot} read back the other way. */
const TABLE_SHOT = /^table-(\d+)\.png$/;

/** The wide tables a saved case was shot with, in the order they appear on the
 *  screen — found rather than named, because how many there are is the screen's
 *  own. The judge is shown them on a re-score exactly as it was on the run. */
async function savedTables(from: string): Promise<string[]> {
  return (await readdir(from))
    .map((name) => TABLE_SHOT.exec(name))
    .filter((found): found is RegExpExecArray => found !== null)
    .sort((left, right) => Number(left[1]) - Number(right[1]))
    .map((found) => found[0]);
}

async function carry(from: string, to: string): Promise<void> {
  for (const name of [...EVIDENCE, ...(await savedTables(from))]) {
    if (!existsSync(join(from, name))) continue;
    await link(join(from, name), join(to, name)).catch(async () => await copyFile(join(from, name), join(to, name)));
  }
}

/** Whether a case asked the screen to DO something. One spelling, because the
 *  floor raises its bar on the same word (`wiredActions` in `floor.ts`) and the
 *  report's write axis is only about these cases. */
const isAction = (testCase: Case): boolean => (testCase.tags ?? []).includes("action");

/** Where a column sits in the report: the declaration order in `DRIVERS`, read
 *  off the harness half of its slug. */
const rank = (slug: string): number => HARNESS_IDS.findIndex((harness) => slug.startsWith(`${harness}-`));

/**
 * A saved run, scored again under today's code, into a new run folder beside it.
 *
 * The floor and the rubric move — the honesty check left the mechanical floor
 * and became a line the judge grades against the tool data — and every screen
 * already recorded was then scored under a contract no new screen will ever be
 * scored under. Generating those screens again is hours and hundreds of dollars
 * for work that is already on disk; grading them again is one judge call each.
 *
 * So nothing is regenerated and nothing is re-probed: the artifact, the page,
 * the picture and the trace on disk are the evidence, `delivered` and
 * `wiredActions` are decided again under today's rules, and the judge answers
 * today's rubric. The source run is never written into — it is the evidence, and
 * a pass that edits its own input can only be run once.
 */
export async function regrade(args: RegradeArgs, options: JudgeOptions = {}): Promise<number> {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const corpus = await corpusOnDisk(join(root, "worlds"));
  const saved = (await readdir(args.runDir, { recursive: true })).filter((path) => basename(path) === "result.json");
  const runId = stampedNow();
  // Made up front rather than by the first case written into it: a pass where
  // every case was refused still owes the reader a summary saying so.
  const runDir = join(dirname(args.runDir), runId);
  await mkdir(runDir, { recursive: true });

  /** Opened at most once, and only for a run recorded before `writeCase` saved
   *  the DOM beside the shot — a re-score of anything newer touches no browser. */
  let opening: Promise<Shooter> | undefined;
  const settledDom = async (html: string): Promise<string> => {
    const visit = await (await (opening ??= openBrowser())).visit(html);
    try {
      return (await visit.shot()).dom;
    } finally {
      await visit.close();
    }
  };

  const worlds: Record<string, World> = {};
  const actionCases = new Set<string>();
  const queue = saved.map((path) => async (): Promise<CaseResult | undefined> => {
    const from = join(args.runDir, dirname(path));
    const was = JSON.parse(await readFile(join(from, "result.json"), "utf8")) as CaseResult;
    // A result names the folder it sits in, so a path that is not ONE run folder
    // — `runs/` rather than `runs/<id>` — says so here, before a judge call.
    // Read whole, it would be re-graded as one enormous run, at a case a call.
    if (dirname(path) !== join(was.contender, was.case)) {
      console.error(`· ${path} · NOT REGRADED — it names itself ${join(was.contender, was.case)}, so ${args.runDir} is not one run folder`);
      return undefined;
    }
    const source = sourceOf(was, corpus);
    if (source === undefined) {
      console.error(
        `· ${was.contender} / ${was.case} · NOT REGRADED — world ${was.world} and case ${was.caseHash} match nothing` +
          ` under worlds/, so this screen was built against a product that has since changed`,
      );
      return undefined;
    }
    const { world, testCase } = source;
    worlds[was.case] = world;
    if (isAction(testCase)) actionCases.add(was.case);
    const file = async (name: string): Promise<string | undefined> =>
      await readFile(join(from, name), "utf8").catch(() => undefined);

    const floor = runFloor({
      world,
      // `delivered` asks whether an artifact came back at all, and only the
      // vendo column saves one of its own: where the artifact IS the document,
      // the page on disk is those bytes with the harness's injection in front of
      // them, which answers the same question off the same evidence.
      artifact: (await file("artifact.tsx")) ?? (await file("page.html")),
      // Carried rather than decided again: a browser settled `renders` and the
      // product's own checks settled `blocking`, and neither piece of machinery
      // moved. Only what today's code would decide differently is recomputed.
      renders: was.floor.renders,
      blocking: was.floor.blocking,
      trace: was.trace,
      tags: testCase.tags ?? [],
    });

    const screenshot = await readFile(join(from, "screenshot.png")).catch(() => undefined);
    const page = await file("page.html");
    // The saved DOM where the run wrote one, and the page painted again where it
    // did not — never re-probed. The trace on disk IS the trace: pressing this
    // screen again would grade a different set of presses from the one the
    // floor above just scored.
    const dom = (await file("dom.html")) ?? (page === undefined ? undefined : await settledDom(page));
    const judged =
      screenshot === undefined || dom === undefined
        ? ungraded(testCase.pass, world.style)
        : await judge(
            {
              screenshot,
              // The run's own extra pictures, never taken again: painting the
              // page to re-shoot a table would grade a screen this folder does
              // not hold. A run recorded before they existed simply has none.
              tables: await Promise.all(
                (await savedTables(from)).map(async (name) => await readFile(join(from, name))),
              ),
              artifact: dom,
              trace: was.trace,
              toolData: toolData(world),
              caseLines: testCase.pass,
              styleLines: world.style,
              caseHash: was.caseHash,
            },
            options,
          );

    // Everything this pass did not decide is the saved result's own, the timing
    // above all: how fast the contender was is not a re-score's to overwrite,
    // and the only new money in this folder is the judge's, which `judged`
    // carries itself. Written through the run's OWN writer, so the folder is
    // nested and named by the code that named the one it came from.
    const result: CaseResult = { ...was, run: runId, floor, judged, judgeContract: JudgeContract };
    await writeCase(runDir, { outcome: undefined, html: undefined, shot: undefined, result });
    await carry(from, join(runDir, result.contender, result.case));
    const scored = checks(floor);
    console.log(
      `· ${result.contender} / ${result.case} · floor ${scored.filter((check) => check.pass).length}/${scored.length}` +
        ` · judged ${saidJudged(judged)} · $${(judged.cost?.usd ?? 0).toFixed(4)}`,
    );
    return result;
  });

  const done = await pool(queue, args.jobs);
  if (opening !== undefined) await (await opening).close();
  const results = done.filter((result): result is CaseResult => result !== undefined);
  // Column order is the run's own, never the disk's: `readdir` walks the folders
  // alphabetically, and a report whose columns moved is not the same report.
  results.sort((left, right) => rank(left.contender) - rank(right.contender));

  const gitSha = (await harnessStamp(root)).gitSha;
  console.log(
    await writeSummary({ runDir, runId, results, gitSha, regradedFrom: basename(args.runDir), worlds, actionCases }),
  );
  console.log(await writePreview({ runDir, runId, results, worlds, actionCases }));
  const refused = done.length - results.length;
  const code = exitCode(results) === 0 && refused === 0 ? 0 : 1;
  console.log(
    `floor failures: ${results.filter((result) => !result.floor.pass).length}` +
      ` · not regraded: ${refused} (exit ${code})`,
  );
  return code;
}

// --------------------------------------------------------------- re-reading

export interface ReportArgs {
  /** The run folder to read back, as it is on disk. */
  readonly runDir: string;
}

/** `report <run folder>` — the folder and nothing else: this pass has no model,
 *  no browser and no queue, so there is nothing else here to name. */
export function parseReport(argv: readonly string[]): ReportArgs {
  const [runDir, ...rest] = argv;
  if (runDir === undefined) throw new Error("genbench: report needs the run folder to read back");
  if (rest.length > 0) throw new Error(`genbench: unexpected argument "${rest[0]}"`);
  return { runDir: resolve(runDir) };
}

/**
 * Every case a saved run folder holds, with the folder checked to BE one.
 *
 * `runs/` is one keystroke from `runs/<id>`, and read whole it is every run at
 * once — added up as a single run, into files dropped in `runs/` itself. A
 * result names the folder it belongs in, so a folder that is not one run says so
 * here, before a pass has written or spent anything. One reader, because every
 * pass over a saved run owes the same refusal.
 */
async function savedResults(
  runDir: string,
): Promise<ReadonlyArray<{ dir: string; result: CaseResult }> | undefined> {
  const saved = (await readdir(runDir, { recursive: true })).filter((path) => basename(path) === "result.json");
  if (saved.length === 0) {
    console.error(`genbench: no result.json under ${runDir}, so there is no run there to read`);
    return undefined;
  }
  const cases: Array<{ dir: string; result: CaseResult }> = [];
  for (const path of saved) {
    const result = JSON.parse(await readFile(join(runDir, path), "utf8")) as CaseResult;
    if (dirname(path) !== join(result.contender, result.case)) {
      console.error(
        `genbench: ${path} names itself ${join(result.contender, result.case)}, so ${runDir} is not one run folder`,
      );
      return undefined;
    }
    cases.push({ dir: join(runDir, dirname(path)), result });
  }
  return cases;
}

/**
 * A saved run's `summary.json` and `preview.html`, written again from the
 * verdicts already in its `result.json` files.
 *
 * How the report READS a run moves without a single verdict moving — the
 * correctness column just split the honesty line out into a column of its own —
 * and every run already on disk then keeps saying the old thing forever.
 * `regrade` would answer that with a judge call per case, which is paying twice
 * for verdicts nobody disputes.
 *
 * So nothing is generated, nothing is graded, and no `result.json` is touched:
 * the saved results are the evidence, and the two files that are merely READ off
 * them are rewritten where they sit.
 */
export async function report(args: ReportArgs): Promise<number> {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const corpus = await corpusOnDisk(join(root, "worlds"));
  const saved = await savedResults(args.runDir);
  if (saved === undefined) return 1;

  const results = saved.map(({ result }) => result);
  const worlds: Record<string, World> = {};
  const actionCases = new Set<string>();
  for (const was of results) {
    // For the data panel and the write axis, and nothing else: a world that has
    // moved since costs the reader those two, and no verdict here is re-decided
    // against it.
    const source = sourceOf(was, corpus);
    if (source === undefined) continue;
    worlds[was.case] = source.world;
    if (isAction(source.testCase)) actionCases.add(was.case);
  }
  // What the folder already says about itself and this pass cannot know: the
  // order its columns were raced in, and — for a run holding another run's
  // screens — whose they were.
  const before = JSON.parse(
    await readFile(join(args.runDir, "summary.json"), "utf8").catch(() => "{}"),
  ) as Partial<RunSummary>;
  // Column order is the run's OWN, never the disk's: `readdir` walks the folders
  // in the disk's order, and a page whose columns moved is not the same page —
  // which is the whole cost of rewriting one in place. The harness order every
  // report is written in settles anything the old summary never named.
  const had = Object.keys(before.columns ?? {});
  const place = (slug: string): number => (had.includes(slug) ? had.indexOf(slug) : had.length + rank(slug));
  results.sort((left, right) => place(left.contender) - place(right.contender));

  const runId = basename(args.runDir);
  console.log(
    await writeSummary({
      runDir: args.runDir,
      runId,
      results,
      // The run's own commit, off the results it saved. This pass re-reads a
      // benchmark that already happened, and the tree it runs from today is not
      // the tree those screens were built at.
      gitSha: results[0]!.gitSha,
      ...(before.regradedFrom === undefined ? {} : { regradedFrom: before.regradedFrom }),
      worlds,
      actionCases,
    }),
  );
  console.log(await writePreview({ runDir: args.runDir, runId, results, worlds, actionCases }));
  return 0;
}

// ---------------------------------------------------------------- liveness

export interface LivenessArgs {
  /** The run folder to score for liveness, as it is on disk. */
  readonly runDir: string;
  /** Cases in flight at once, exactly as a run's — each one holds a browser
   *  page, twice. */
  readonly jobs: number;
}

/** `liveness <run folder>`, and the run's own `--jobs`. */
export const parseLiveness = (argv: readonly string[]): LivenessArgs =>
  parseFolderPass(argv, "liveness needs the run folder to score");

/** One column's liveness in the words the preview uses, for the terminal — with
 *  the accusations nobody could reach a verdict on named, because an adjudicator
 *  that is quietly unreachable makes every column look better and the ratio
 *  alone cannot say so. */
const saidLive = (alive: LivenessResult | undefined): string => {
  if (alive === undefined) return "—";
  const open = (alive.adjudications ?? []).filter((one) => one.verdict === "unadjudicated").length;
  const aside = open === 0 ? "" : ` · ${open} unadjudicated`;
  return alive.vacuous === true ? `— none shown${aside}` : `${alive.live}/${alive.displayed}${aside}`;
};

/**
 * Liveness for a run that is already on disk, added where it sits.
 *
 * The axis arrived after runs had been recorded, and it needs no contender and
 * no judge — only the page each case already saved, a browser to paint it twice
 * in, and one small call for each value the search accuses of being stale. So
 * any saved run can be scored for it at any time, and two runs a month apart
 * still compare.
 *
 * This is the one pass that writes into the folder it read, and it is safe for
 * the reason no other pass is: it ADDS a field nothing else decides, from a
 * mutation that is arithmetic with no clock and no randomness in it. Every
 * verdict already in the folder is left exactly as it was — nothing is
 * re-judged, no floor cell moves, and the exit code is the report's.
 */
export async function scoreLiveness(args: LivenessArgs, options: LivenessOptions = {}): Promise<number> {
  const saved = await savedResults(args.runDir);
  if (saved === undefined) return 1;
  const shooter = await openBrowser();
  try {
    await pool(
      saved.map(({ dir, result }) => async (): Promise<void> => {
        const page = await readFile(join(dir, "page.html"), "utf8").catch(() => undefined);
        // A column that delivered no page has nothing that could be bound to
        // anything, and saying nothing is the honest reading: a 0/0 here would
        // claim a screen was looked at and showed none of the data.
        if (page === undefined) return;
        const alive = await liveness(shooter, page, options);
        await writeFile(join(dir, "result.json"), `${JSON.stringify({ ...result, liveness: alive }, null, 2)}\n`);
        console.log(`· ${result.contender} / ${result.case} · liveness ${saidLive(alive)}`);
      }),
      args.jobs,
    );
  } finally {
    await shooter.close();
  }
  // The two files that are merely READ off the results, rewritten off the ones
  // this pass just changed.
  return await report({ runDir: args.runDir });
}

async function main(argv: readonly string[]): Promise<number> {
  // Reading a saved run back spends nothing at all — no key, no model, no
  // browser — so it is answered above the key check that every other pass owes.
  if (argv[0] === "report") return await report(parseReport(argv.slice(1)));
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey === undefined || apiKey === "") {
    console.error("genbench: ANTHROPIC_API_KEY is not set");
    return 1;
  }
  // Re-scoring spends the judge and nothing else: no contender's tokens, no
  // other vendor's key, and no browser at all where the run saved its DOM.
  if (argv[0] === "regrade") return await regrade(parseRegrade(argv.slice(1)));
  // Liveness spends a browser, and the adjudicator on whatever the digit search
  // accuses — pennies a page, nothing at all on a page it accuses nothing on.
  // It asks for the key up front all the same: a keyless run would paint both
  // frames and then leave every accusation unadjudicated, which is a whole run
  // spent to report that nothing was decided.
  if (argv[0] === "liveness") return await scoreLiveness(parseLiveness(argv.slice(1)));
  const args = parseArgs(argv);
  // The row is built once, here, for the same reason the keys are demanded
  // here: a selection that leaves no column at all is a run with nothing to
  // measure, and it should say so before a browser opens. The preflight and the
  // run itself then read that SAME list, so a key can never be demanded for a
  // column that will not run.
  const row = contenders(args.models, args.contenders);
  const missing = missingKey(row, process.env);
  if (missing !== undefined) {
    console.error(missing);
    return 1;
  }

  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const worldsDir = join(root, "worlds");
  const names = await worldsFor(worldsDir, args.world);

  const runId = stampedNow();
  const runDir = join(root, "runs", runId);
  const anthropic = createAnthropic({ apiKey });
  const wafer = createOpenAICompatible({ name: "wafer", baseURL: WAFER_BASE_URL, apiKey: process.env.WAFER_API_KEY });
  // The official OpenRouter provider is AI SDK v7 only and this harness is on
  // v6, so the router is reached through the same OpenAI-compatible adapter
  // Wafer is — which is all their endpoint asks for.
  const openrouter = createOpenAICompatible({
    name: "openrouter",
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: process.env.OPENROUTER_API_KEY,
  });
  const thesys = thesysProvider({ apiKey: process.env.THESYS_API_KEY });
  const bundle = await bundleMount();
  const shooter = await openBrowser();
  const results: CaseResult[] = [];
  /** The columns being run right now, so a late failure's loud line can say what
   *  it landed beside. */
  const inFlight = new Set<string>();
  surviveLateFailures(inFlight);
  /** The world each case was actually graded against — what the report's data
   *  panel shows, so a person can check any number on any screen against it. */
  const worlds: Record<string, World> = {};
  /** The cases that asked the screen to DO something: the only ones the
   *  report's write axis is about, and nothing in `result.json` says it. */
  const actionCases = new Set<string>();
  const stamp = await harnessStamp(root);

  /** One column of one case, start to finish, reporting rather than throwing.
   *  `key` is the case's own id, or `<world>/<id>` where a run covers more than
   *  one world — two worlds really do ship a `visit-history`, and one run folder
   *  would otherwise write both into the same directory. */
  const runOne = async (contender: ContenderId, testCase: Case, scoped: World, key: string): Promise<CaseResult> => {
    const { at, modelId } = door(contender);
    // Its own meter, so a sibling's tokens and a sibling's clock are never
    // charged to this column.
    const meter = meteredModel({ anthropic, wafer, thesys, openrouter }[at](modelId), modelId);

    /** Evidence as it is produced, not as it is returned. Losing the outer race
     *  used to discard a screenshot that had already been taken and a trace that
     *  had already been recorded, so a case that ran out of time was graded as
     *  a screen that failed every check — the harness's clock reported as the
     *  contender's quality. Whatever exists is graded; the timeout is recorded
     *  beside it as itself. */
    const captured: { outcome?: RunOutcome; html?: string; shot?: Shot; trace?: Probed[] } = {};

    const label = `${contender.slug} / ${key}`;
    inFlight.add(label);
    // Raced against the clock as one unit: generation, paint and probe all spend
    // the person's wait, so one budget covers all three.
    const { failure: broke } = await attempt(async (lost, spent) => {
      captured.outcome = await DRIVERS[contender.harness](contender.model).run({
        world: scoped,
        testCase,
        meter,
        // The BUDGET, not the bell: a driver that answers it hands over the last
        // screen it painted with enough of the case's clock left to paint and
        // press it, and that screen is graded exactly as a screen that arrived
        // on time — the cap rides along as `failure` beside it.
        signal: spent,
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
    inFlight.delete(label);

    // Read out before anything else is awaited: work that lost the race is still
    // running and still writing into `captured`.
    const { outcome, html: page, shot, trace = [] } = captured;
    const artifact = outcome?.artifact;
    const floor = runFloor({
      world: scoped,
      artifact,
      blocking: outcome?.blocking ?? [],
      trace,
      renders: shot?.renders === true,
      tags: testCase.tags ?? [],
    });

    // Outside the contender's budget too, and for the same reason: the two
    // extra paints and whatever they accuse are the benchmark's instrument, not
    // the person's wait. Only asked of a screen that really painted — a case
    // that timed out before it reached a browser has no page to move the data
    // under.
    // `.catch`, because the instrument must never cost the case: a liveness
    // paint that times out on a loaded machine is a reading nobody got, not a
    // screen nobody built (2026-08-19 — one such timeout, unguarded, ended the
    // whole run).
    const alive = page === undefined || shot === undefined ? undefined : await liveness(shooter, page).catch(() => undefined);

    // Outside the contender's budget: the wait is the grader's, and charging it
    // to the column would report a timeout the contender never had. `judge`
    // owns its own retries and never throws, so a judge having a bad afternoon
    // lands as a degraded verdict rather than a lost case — and a `--floor-only`
    // sweep never opens the question, which is what makes it cheap.
    const judged = args.floorOnly
      ? unjudged
      : shot === undefined
        ? ungraded(testCase.pass, scoped.style)
        : await judge({
            screenshot: shot.png,
            // And the fold, where the screen has one: a table wider than the
            // frame at its full scroll width, which is the only way the columns
            // past the fold are evidence at all.
            tables: shot.tables,
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
            // The ground truth behind the screen: what every tool this case's
            // screens could call answers with. The standing honesty line is
            // graded against it, and it is the world's own data rather than
            // anything the contender said about it.
            toolData: toolData(scoped),
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
      ...(alive === undefined ? {} : { liveness: alive }),
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
      ...(meter.answeredBy() === undefined ? {} : { modelVersion: meter.answeredBy()! }),
      ...stamp,
      ...(outcome?.session === undefined ? {} : { session: outcome.session }),
      ...(outcome?.pipeline === undefined ? {} : { pipeline: outcome.pipeline }),
      ...(failure === undefined ? {} : { failure }),
    };
    await writeCase(runDir, { outcome, html: page, shot, result });
    const scored = checks(floor);
    console.log(
      `· ${label} · floor ${scored.filter((check) => check.pass).length}/${scored.length}` +
        ` · live ${saidLive(alive)}` +
        ` · judged ${saidJudged(judged)}` +
        ` · ${result.timing.settledMs}ms · $${result.cost.usd.toFixed(4)}` +
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
        if (isAction(testCase)) actionCases.add(key);
        // The whole row at once: they share only the browser, a page each, and the
        // order of `results` is the order of `contenders` whoever finishes first.
        cases.push(
          async () =>
            await Promise.all(row.map(async (contender) => await runOne(contender, testCase, scoped, key))),
        );
      }
    }
    results.push(...(await pool(cases, args.jobs)).flat());
  } finally {
    await shooter.close();
  }
  if (results.length === 0) throw new Error(`genbench: no case matches --prompt "${args.only ?? ""}"`);

  const summary = await writeSummary({ runDir, runId, results, gitSha: stamp.gitSha, worlds, actionCases });
  console.log(summary);
  const preview = await writePreview({ runDir, runId, results, worlds, actionCases });
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
