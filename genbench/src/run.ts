import { createAnthropic } from "@ai-sdk/anthropic";
import type { UIPayload } from "@vendoai/core";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runFloor, type FloorResult } from "./floor.js";
import { meteredModel, MODEL_IDS, type Meter, type ModelAlias, type UsageTotals } from "./meter.js";
import { openBrowser, treeHtml } from "./render.js";
import { writePreview } from "./report.js";
import { vendoDriver } from "./vendo.js";
import { loadCases, loadWorld, worldForCase, type Case, type Lane, type World } from "./world.js";

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
  readonly snapshots: ReadonlyArray<{ atMs: number; payload: UIPayload }>;
  readonly firstRenderMs?: number;
  readonly settledMs: number;
  /** The contender's own failure sentence, when it has one. */
  readonly failure?: string;
}

export interface Contender {
  readonly harness: HarnessId;
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
  /** Nodes the writer generated as islands. They are client-only, so they are
   *  blank in a server-rendered screenshot — a non-zero count means the shot
   *  understates what the product actually built. */
  readonly islands: number;
  /** Kit charts on the screen. They are recharts-backed and measure their
   *  container in the browser, so they leave an empty band in a server-rendered
   *  shot for the same reason islands do. Counted so the gap is never silent. */
  readonly clientOnly: number;
  readonly world: string;
  readonly failure?: string;
}

const DRIVERS: Partial<Record<HarnessId, () => Contender>> = { vendo: vendoDriver };

interface Args {
  readonly only?: string;
  readonly lane: Lane;
  readonly models: readonly ModelAlias[];
}

export function parseArgs(argv: readonly string[]): Args {
  const rest = argv[0] === "run" ? argv.slice(1) : argv;
  let only: string | undefined;
  let lane: Lane = "screen";
  let models: readonly ModelAlias[] = ["sonnet"];
  let index = 0;
  while (index < rest.length) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (value === undefined) throw new Error(`genbench: "${flag}" needs a value`);
    if (flag === "--prompt") only = value;
    else if (flag === "--lane") lane = asLane(value);
    else if (flag === "--models") models = value.split(",").map(asAlias);
    else throw new Error(`genbench: unexpected argument "${flag}"`);
    index += 2;
  }
  return { ...(only === undefined ? {} : { only }), lane, models };
}

function asLane(value: string): Lane {
  if (value !== "screen" && value !== "build") throw new Error(`genbench: unknown lane "${value}"`);
  return value;
}

function asAlias(value: string): ModelAlias {
  if (!Object.hasOwn(MODEL_IDS, value)) throw new Error(`genbench: unknown model "${value}"`);
  return value as ModelAlias;
}

/** Every contender that has a driver today, in every requested model. The diy
 *  and claude-code columns join here the day their drivers land. */
export function contenders(models: readonly ModelAlias[]): readonly ContenderId[] {
  return Object.keys(DRIVERS).flatMap((harness) =>
    models.map((model) => ({ harness: harness as HarnessId, model, slug: `${harness}-${model}` })),
  );
}

/** The recharts-backed Kit components (packages/ui/src/kit/charts/). */
const CHARTS = new Set(["LineChart", "BarChart", "DonutChart", "Sparkline"]);

const nodesOf = (payload: UIPayload | undefined): ReadonlyArray<{ source?: string; component?: string }> =>
  (payload as { nodes?: Array<{ source?: string; component?: string }> } | undefined)?.nodes ?? [];

const countIslands = (payload: UIPayload | undefined): number =>
  nodesOf(payload).filter((node) => node.source === "generated").length;

const countClientOnly = (payload: UIPayload | undefined): number =>
  nodesOf(payload).filter((node) => node.component !== undefined && CHARTS.has(node.component)).length;

async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.lane === "build") {
    console.log("build lane: deferred");
    return 0;
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey === undefined || apiKey === "") {
    console.error("genbench: ANTHROPIC_API_KEY is not set");
    return 1;
  }

  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const world = await loadWorld(join(root, "world.json"));
  const all = await loadCases(join(root, "cases.json"));
  const cases = all.filter((entry) => entry.lane === args.lane && (args.only === undefined || entry.id === args.only));
  if (cases.length === 0) throw new Error(`genbench: no case matches --prompt "${args.only ?? ""}"`);

  const runId = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const runDir = join(root, "runs", runId);
  const anthropic = createAnthropic({ apiKey });
  const shooter = await openBrowser();
  const results: CaseResult[] = [];

  try {
    for (const contender of contenders(args.models)) {
      const driver = DRIVERS[contender.harness]!();
      for (const testCase of cases) {
        const modelId = MODEL_IDS[contender.model];
        const meter = meteredModel(anthropic(modelId), modelId);
        const scoped = worldForCase(world, testCase);
        console.log(`· ${contender.slug} / ${testCase.id}`);

        const outcome = await driver.run({ world: scoped, testCase, meter });
        const html = outcome.payload === undefined ? undefined : treeHtml(outcome.payload, world.theme);
        const shot = html === undefined ? undefined : await shooter.shot(html);
        const floor = runFloor({
          world: scoped,
          artifact: outcome.artifact,
          blocking: outcome.blocking,
          payload: outcome.payload,
          shot,
        });

        const caseDir = join(runDir, contender.slug, testCase.id);
        await mkdir(caseDir, { recursive: true });
        if (outcome.artifact !== undefined) await writeFile(join(caseDir, "artifact.vendo"), outcome.artifact);
        if (shot !== undefined) await writeFile(join(caseDir, "screenshot.png"), shot.png);

        const result: CaseResult = {
          run: runId,
          contender: contender.slug,
          model: modelId,
          case: testCase.id,
          prompt: testCase.prompt,
          lane: testCase.lane,
          floor,
          timing: {
            ...(outcome.firstRenderMs === undefined ? {} : { firstRenderMs: outcome.firstRenderMs }),
            settledMs: outcome.settledMs,
          },
          cost: { usage: meter.totals(), usd: meter.usd() },
          islands: countIslands(outcome.payload),
          clientOnly: countClientOnly(outcome.payload),
          world: world.hash,
          ...(outcome.failure === undefined ? {} : { failure: outcome.failure }),
        };
        await writeFile(join(caseDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
        results.push(result);
        console.log(
          `  floor ${[floor.delivered, floor.renders, floor.valid, floor.honestData.pass, floor.wiredActions.pass].filter(Boolean).length}/5` +
            ` · ${result.timing.settledMs}ms · $${result.cost.usd.toFixed(4)}`,
        );
      }
    }
  } finally {
    await shooter.close();
  }

  const preview = await writePreview({ runDir, runId, results });
  console.log(preview);
  if (process.platform === "darwin") spawn("open", [preview], { detached: true, stdio: "ignore" }).unref();
  return results.every((result) => result.floor.pass) ? 0 : 1;
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
