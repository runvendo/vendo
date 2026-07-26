import { rm } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { runDemoCreate, type DemoCreateArgs, type DemoCreateResult } from "./create.js";
import { defaultExec, type ExecFn } from "./deploy.js";
import { runJudgeLoop, type JudgeLoopArgs, type JudgeLoopIo, type JudgeLoopResult } from "./judge.js";
import { runDemoResearch, type DemoResearchArgs, type DemoResearchResult } from "./research.js";
import { runRewrite, type RewriteArgs, type RewriteIo, type RewriteResult } from "./rewrite.js";

/**
 * `demo:pipeline` — the one-command drive of the whole demo-creator flow:
 * validate → create → install → research (→ rewrite → judge → deploy → final
 * gate, added stage by stage). Two properties the individual commands can't
 * give on their own:
 *
 *  - Fail-fast with a clean abort: the prospect URL is probed BEFORE anything
 *    touches disk, and an early-stage failure (create/install/research)
 *    removes the half-made app dir, so a dead run leaves no app dir, no
 *    deploy, and no registry row behind.
 *  - Per-stage observability: every stage appends {stage, startedAt, ms} to
 *    <app>/timings.json and logs a one-line marker — the empirical basis for
 *    the ≤45-minute budget.
 */

export interface DemoPipelineArgs {
  id: string;
  prospect: string;
  url: string;
  ctaUrl?: string;
  targetDir: string;
  screenshots?: string[];
  /** Stop after the local stages (no Railway, no registry row). */
  skipDeploy: boolean;
  /** Local port for the judge/gate boots — never 3000 (capture-harness lock). */
  port: number;
}

const valueOptions = new Set(["--id", "--prospect", "--url", "--cta-url", "--target-dir", "--screenshots", "--port"]);
const flagOptions = new Set(["--skip-deploy"]);

export function parseDemoPipelineArgs(argv: string[]): DemoPipelineArgs {
  const normalizedArgv = argv[0] === "--" ? argv.slice(1) : argv;
  const options = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < normalizedArgv.length; index += 1) {
    const option = normalizedArgv[index];
    if (!option?.startsWith("--")) throw new Error(`Unexpected argument: ${option ?? ""}`);
    if (flagOptions.has(option)) {
      flags.add(option);
      continue;
    }
    if (!valueOptions.has(option)) throw new Error(`Unknown option: ${option}`);
    const value = normalizedArgv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${option} requires a value`);
    options.set(option, value);
    index += 1;
  }
  const id = options.get("--id");
  if (id === undefined) throw new Error("--id is required");
  const prospect = options.get("--prospect");
  if (prospect === undefined) throw new Error("--prospect is required");
  const url = options.get("--url");
  if (url === undefined) throw new Error("--url is required (the prospect site the pipeline researches)");
  const ctaUrl = options.get("--cta-url");
  const rawPort = options.get("--port");
  const port = rawPort === undefined ? 3150 : Number(rawPort);
  if (!Number.isInteger(port) || port <= 0) throw new Error(`--port must be a positive integer (received ${rawPort})`);
  if (port === 3000) throw new Error("--port 3000 is reserved for the capture harness's shared lock — pick another port");
  const rawScreenshots = options.get("--screenshots");
  let screenshots: string[] | undefined;
  if (rawScreenshots !== undefined) {
    screenshots = rawScreenshots.split(",").map((entry) => entry.trim()).filter((entry) => entry !== "");
    if (screenshots.length === 0) throw new Error("--screenshots needs at least one image path (comma-separated)");
  }
  return {
    id,
    prospect,
    url,
    targetDir: options.get("--target-dir") ?? "apps",
    skipDeploy: flags.has("--skip-deploy"),
    port,
    ...(ctaUrl === undefined ? {} : { ctaUrl }),
    ...(screenshots === undefined ? {} : { screenshots }),
  };
}

/** A parked run: fidelity stayed below the bar after every fix round. The
 * evidence (FIDELITY.md, judge screenshots, the app dir) is kept; nothing is
 * deployed. Callers exit non-zero but should NOT treat this as a crash. */
export class DemoParkedError extends Error {
  readonly reportPath: string;
  constructor(message: string, reportPath: string) {
    super(message);
    this.name = "DemoParkedError";
    this.reportPath = reportPath;
  }
}

// ---------------------------------------------------------------------------
// Fail-fast URL validation
// ---------------------------------------------------------------------------

/**
 * Probes the prospect URL before the pipeline touches disk. Reachable means
 * "a live server answered at all": any HTTP status below 500 passes (bot
 * walls answer 403, some servers reject HEAD with 405 — a challenge page
 * still proves the site exists; the research stage deals with junk evidence
 * separately). HEAD is tried first, then GET; network errors, timeouts, and
 * persistent 5xx are unreachable.
 */
export async function validateProspectUrl(
  url: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  let lastFailure = "";
  for (const method of ["HEAD", "GET"]) {
    try {
      const response = await fetchImpl(url, { method, redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
      if (response.status < 500) return;
      lastFailure = `HTTP ${response.status}`;
    } catch (error) {
      lastFailure = error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error);
    }
  }
  throw new Error(`Prospect URL ${url} is unreachable (${lastFailure}) — nothing was created. Fix the URL and re-run.`);
}

// ---------------------------------------------------------------------------
// Stage runner
// ---------------------------------------------------------------------------

/** One row of <app>/timings.json — the per-stage wall-clock evidence. */
export interface StageTiming {
  stage: string;
  startedAt: string;
  ms: number;
}

/** Stage seams so unit tests drive the pipeline without a browser/Railway. */
export interface PipelineStages {
  create: (args: DemoCreateArgs, options: { repoRoot: string }) => Promise<DemoCreateResult>;
  research: (args: DemoResearchArgs, options: { repoRoot: string }) => Promise<DemoResearchResult>;
  rewrite: (args: RewriteArgs, io: RewriteIo) => Promise<RewriteResult>;
  judge: (args: JudgeLoopArgs, io: JudgeLoopIo) => Promise<JudgeLoopResult>;
}

const defaultStages: PipelineStages = {
  create: runDemoCreate,
  research: runDemoResearch,
  rewrite: runRewrite,
  judge: runJudgeLoop,
};

export interface PipelineIo {
  repoRoot: string;
  stages?: PipelineStages;
  fetchImpl?: typeof fetch;
  exec?: ExecFn;
  write?: (line: string) => void;
}

export interface DemoPipelineResult {
  appDir: string;
  appPath: string;
  timings: StageTiming[];
  rewrite: RewriteResult;
  judge: JudgeLoopResult;
}

export function timingsPath(appDir: string): string {
  return path.join(appDir, "timings.json");
}

export async function runDemoPipeline(args: DemoPipelineArgs, io: PipelineIo): Promise<DemoPipelineResult> {
  const stages = io.stages ?? defaultStages;
  const exec = io.exec ?? defaultExec;
  const write = io.write ?? ((line: string) => process.stdout.write(`${line}\n`));

  const timings: StageTiming[] = [];
  let appDir: string | undefined;
  // Failures in create/install/research abort clean (nothing worth keeping);
  // once the creative rewrite starts, the evidence trail is the point — later
  // failures leave the app dir in place for the park report.
  let cleanupOnAbort = true;

  const stage = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const startedAt = new Date().toISOString();
    const t0 = performance.now();
    write(`[pipeline] ${name} started`);
    try {
      return await fn();
    } finally {
      const ms = Math.round(performance.now() - t0);
      timings.push({ stage: name, startedAt, ms });
      write(`[pipeline] ${name} finished in ${ms}ms`);
      if (appDir !== undefined) {
        await writeFile(timingsPath(appDir), `${JSON.stringify(timings, null, 2)}\n`).catch(() => undefined);
      }
    }
  };

  try {
    // Fail-fast: nothing exists yet, so an unreachable prospect aborts with
    // no app dir, no deploy, no registry row (criterion 33).
    await stage("validate", () => validateProspectUrl(args.url, { fetchImpl: io.fetchImpl }));

    const created = await stage("create", () => stages.create({
      id: args.id,
      prospect: args.prospect,
      ctaUrl: args.ctaUrl ?? "https://cal.com/yousefhelal",
      targetDir: args.targetDir,
      url: args.url,
      ...(args.screenshots === undefined ? {} : { screenshots: args.screenshots }),
    }, { repoRoot: io.repoRoot }));
    appDir = created.appDir;

    await stage("install", async () => {
      const result = await exec(["pnpm", "install"], { cwd: io.repoRoot });
      if (result.code !== 0) {
        throw new Error(`"pnpm install" (workspace link) failed (exit ${result.code}):\n${result.stderr || result.stdout}`);
      }
    });

    await stage("research", () => stages.research(
      { app: appDir as string, urls: [args.url] },
      { repoRoot: io.repoRoot },
    ));

    cleanupOnAbort = false;
    const rewrite = await stages.rewrite(
      { prospect: args.prospect, url: args.url, packageName: created.packageName },
      {
        repoRoot: io.repoRoot,
        appDir,
        write,
        runStage: stage,
        ...(io.exec === undefined ? {} : { exec: io.exec }),
      },
    );

    // The judge loop parks rather than throwing: a parked run is a verdict
    // with evidence, not a crash — but it must never reach deploy.
    const judge = await stages.judge(
      { prospect: args.prospect, packageName: created.packageName, plan: rewrite.plan, port: args.port },
      {
        appDir,
        repoRoot: io.repoRoot,
        write,
        runStage: stage,
        ...(io.exec === undefined ? {} : { exec: io.exec }),
      },
    );
    if (judge.parked) {
      throw new DemoParkedError(
        `PARKED below the fidelity bar — see ${judge.reportPath} for per-dimension scores. Nothing was deployed.`,
        judge.reportPath,
      );
    }

    return { appDir, appPath: path.relative(io.repoRoot, appDir), timings, rewrite, judge };
  } catch (error) {
    // Early-stage abort keeps the repo pristine. Later stages (rewrite, judge,
    // deploy, gate) park WITH evidence instead — the app dir stays.
    if (appDir !== undefined && cleanupOnAbort) {
      await rm(appDir, { recursive: true, force: true }).catch(() => undefined);
    }
    throw error;
  }
}
