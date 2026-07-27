import { rm } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { runDeriveChips, type DeriveChipsIo, type DeriveChipsResult } from "./chips.js";
import { displayAppPath, runDemoCreate, validateProspectUrl, type DemoCreateArgs, type DemoCreateResult } from "./create.js";
import { defaultExec, runDemoDeploy, type DemoDeployArgs, type DemoDeployResult, type DeployIo, type ExecFn } from "./deploy.js";
import { runFinalGate, type FinalGateArgs, type FinalGateIo, type FinalGateResult } from "./gate.js";
import { demoPassword } from "./inject-auth.js";
import { runJudgeLoop, type JudgeLoopArgs, type JudgeLoopIo, type JudgeLoopResult } from "./judge.js";
import { runDemoResearch, type DemoResearchArgs, type DemoResearchResult } from "./research.js";
import { runRewrite, type RewriteArgs, type RewriteIo, type RewriteResult } from "./rewrite.js";
import { appInstallCommand, defaultDemoScratchDir } from "./scratch.js";

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
  /** Skip the local demo-beats GIF capture (fast iteration runs only). */
  skipCapture: boolean;
  /** Local port for the judge/capture boots — never 3000 (capture-harness lock). */
  port: number;
}

const valueOptions = new Set(["--id", "--prospect", "--url", "--cta-url", "--target-dir", "--screenshots", "--port"]);
const flagOptions = new Set(["--skip-deploy", "--skip-capture"]);

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
    targetDir: options.get("--target-dir") ?? defaultDemoScratchDir(),
    skipDeploy: flags.has("--skip-deploy"),
    skipCapture: flags.has("--skip-capture"),
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

// The fail-fast URL probe lives in create.ts (criterion 33 binds it to
// demo:create itself); the pipeline re-runs it as its own first stage.
export { validateProspectUrl };

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
  create: (args: DemoCreateArgs, options: { repoRoot: string; fetchImpl?: typeof fetch; signal?: AbortSignal }) => Promise<DemoCreateResult>;
  research: (args: DemoResearchArgs, options: { repoRoot: string; signal?: AbortSignal }) => Promise<DemoResearchResult>;
  rewrite: (args: RewriteArgs, io: RewriteIo) => Promise<RewriteResult>;
  chips: (args: { appDir: string; prospect?: string }, io: DeriveChipsIo) => Promise<DeriveChipsResult>;
  judge: (args: JudgeLoopArgs, io: JudgeLoopIo) => Promise<JudgeLoopResult>;
  deploy: (args: DemoDeployArgs, io: DeployIo) => Promise<DemoDeployResult>;
  gate: (args: FinalGateArgs, io: FinalGateIo) => Promise<FinalGateResult>;
}

const defaultStages: PipelineStages = {
  create: runDemoCreate,
  research: runDemoResearch,
  rewrite: runRewrite,
  chips: runDeriveChips,
  judge: runJudgeLoop,
  deploy: runDemoDeploy,
  gate: runFinalGate,
};

export interface PipelineIo {
  repoRoot: string;
  stages?: PipelineStages;
  fetchImpl?: typeof fetch;
  exec?: ExecFn;
  write?: (line: string) => void;
  /** Pipeline-wide wall-clock hard cap (default 2h). Past the deadline no
   * further stage starts: the run PARKS with named gaps and never deploys. */
  capMs?: number;
  /** Pause between deploy retries (default 30s; tests shrink it). */
  deployRetryWaitMs?: number;
}

/** The contract's hard cap: a run that hasn't shipped in 2 hours parks. */
export const defaultCapMs = 2 * 60 * 60 * 1000;

export interface DemoPipelineResult {
  appDir: string;
  appPath: string;
  timings: StageTiming[];
  rewrite: RewriteResult;
  judge: JudgeLoopResult;
  /** Absent with --skip-capture. */
  gifPath?: string;
  /** Absent with --skip-deploy. */
  deploy?: DemoDeployResult;
  gate?: FinalGateResult;
  demoUrl?: string;
}

export function timingsPath(appDir: string): string {
  return path.join(appDir, "timings.json");
}

export async function runDemoPipeline(args: DemoPipelineArgs, io: PipelineIo): Promise<DemoPipelineResult> {
  const stages = io.stages ?? defaultStages;
  const write = io.write ?? ((line: string) => process.stdout.write(`${line}\n`));

  // The cap is a run-level AbortController: when it fires, every in-flight
  // child process (creator agents, railway up, capture, builds) is killed via
  // the threaded signal — the losing stage is CANCELLED, not just abandoned,
  // so nothing (least of all a deploy) can complete after the park.
  const capController = new AbortController();
  const capSignal = capController.signal;
  const baseExec = io.exec ?? defaultExec;
  const exec: ExecFn = (command, options) => baseExec(command, { signal: capSignal, ...options });

  const timings: StageTiming[] = [];
  let appDir: string | undefined;
  // Failures in create/install/research abort clean (nothing worth keeping);
  // once the creative rewrite starts, the evidence trail is the point — later
  // failures leave the app dir in place for the park report.
  let cleanupOnAbort = true;

  const deadline = Date.now() + (io.capMs ?? defaultCapMs);
  const capMinutes = Math.round((io.capMs ?? defaultCapMs) / 60000);
  const capTimer = setTimeout(() => capController.abort(new Error(`the ${capMinutes}-minute wall-clock cap fired`)), Math.max(0, deadline - Date.now()));
  capTimer.unref?.();
  const plannedStages = ["validate", "create", "install", "research", "rewrite", "chips", "judge", "capture", "deploy", "final-gate"];
  const stageCounts = new Map<string, number>();

  const parkAtCap = (context: string): DemoParkedError => {
    const done = new Set(timings.map((row) => row.stage.split(":")[0]?.split("#")[0]));
    const remaining = plannedStages.filter((planned) => !done.has(planned));
    const gaps = `completed: ${[...done].join(", ") || "(none)"}; not run: ${remaining.join(", ")}`;
    const reportPath = appDir === undefined ? "(no app dir — nothing was created)" : timingsPath(appDir);
    return new DemoParkedError(
      `PARKED at the ${capMinutes}-minute wall-clock cap ${context} — ${gaps}. Nothing was deployed. Timings: ${reportPath}`,
      reportPath,
    );
  };

  const stage = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    // The hard cap bounds the RUN, not just stage starts: a stage is raced
    // against the deadline and the run parks mid-stage when it fires
    // (criterion 34's 2h cap — deploy can never be reached past it).
    if (Date.now() > deadline) throw parkAtCap(`before stage "${name}"`);
    // Distinct row per occurrence: a retried/repeated stage gets "#n" so the
    // timing table stays one honest row per thing that actually ran.
    const count = (stageCounts.get(name) ?? 0) + 1;
    stageCounts.set(name, count);
    const rowName = count === 1 ? name : `${name}#${count}`;
    const startedAt = new Date().toISOString();
    const t0 = performance.now();
    write(`[pipeline] ${rowName} started`);
    let onCapAbort: (() => void) | undefined;
    try {
      const capFiredMidStage = new Promise<never>((_resolve, reject) => {
        onCapAbort = () => reject(parkAtCap(`during stage "${rowName}" (aborted mid-stage)`));
        if (capSignal.aborted) onCapAbort();
        else capSignal.addEventListener("abort", onCapAbort, { once: true });
      });
      const stagePromise = fn();
      // The aborted stage's own late rejection (killed subprocess etc.) is
      // expected noise once the park has won the race.
      void stagePromise.catch(() => undefined);
      return await Promise.race([stagePromise, capFiredMidStage]);
    } finally {
      if (onCapAbort !== undefined) capSignal.removeEventListener("abort", onCapAbort);
      const ms = Math.round(performance.now() - t0);
      timings.push({ stage: rowName, startedAt, ms });
      write(`[pipeline] ${rowName} finished in ${ms}ms`);
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
    }, { repoRoot: io.repoRoot, signal: capSignal, ...(io.fetchImpl === undefined ? {} : { fetchImpl: io.fetchImpl }) }));
    appDir = created.appDir;

    // A scratch clone installs its own deps (registry + its vendored
    // @vendoai tarballs); an in-repo one relinks the workspace.
    await stage("install", async () => {
      const install = appInstallCommand({ repoRoot: io.repoRoot, appDir: appDir as string });
      const result = await exec(install.command, { cwd: install.cwd });
      if (result.code !== 0) {
        throw new Error(`"pnpm install" in "${install.cwd}" failed (exit ${result.code}):\n${result.stderr || result.stdout}`);
      }
    });

    await stage("research", () => stages.research(
      { app: appDir as string, urls: [args.url] },
      { repoRoot: io.repoRoot, signal: capSignal },
    ));

    cleanupOnAbort = false;
    const rewrite = await stages.rewrite(
      { prospect: args.prospect, url: args.url, packageName: created.packageName },
      {
        repoRoot: io.repoRoot,
        appDir,
        write,
        runStage: stage,
        exec,
        signal: capSignal,
      },
    );

    // Pills, derived from the demo's OWN tool surface. Runs AFTER the rewrite
    // because .vendo/tools.json is only the prospect's surface once the
    // rewrite's build has re-synced it from the rewritten openapi.json. A
    // failed derivation must not sink a good demo: the beats the rewrite
    // already wrote stay, and the run continues.
    await stage("chips", () => stages.chips(
      { appDir: appDir as string, prospect: args.prospect },
      { write },
    ).catch((error) => {
      write(`[chips] derivation failed, keeping the rewrite's beats (${error instanceof Error ? error.message.split("\n")[0] : String(error)})`);
      return undefined;
    }));

    // The judge loop parks rather than throwing: a parked run is a verdict
    // with evidence, not a crash — but it must never reach deploy.
    const judge = await stages.judge(
      { prospect: args.prospect, packageName: created.packageName, plan: rewrite.plan, port: args.port },
      {
        appDir,
        repoRoot: io.repoRoot,
        write,
        runStage: stage,
        exec,
        signal: capSignal,
      },
    );
    if (judge.parked) {
      throw new DemoParkedError(
        `PARKED below the fidelity bar — see ${judge.reportPath} for per-dimension scores. Nothing was deployed.`,
        judge.reportPath,
      );
    }

    // Repo-relative for an in-repo app, absolute for a scratch clone — the
    // shape every downstream `--app`/`--host-config` consumer accepts.
    const appPath = displayAppPath(io.repoRoot, appDir);

    // Behavior verification + the GIF deliverable: the demo-beats capture
    // (playbook §2.8) boots the app locally, runs every beat in one recording,
    // and FAILS unless each declared expectation visibly delivered.
    let gifPath: string | undefined;
    if (!args.skipCapture) {
      const runId = `${args.id}-verify`;
      await stage("capture", async () => {
        const capture = await exec([
          "pnpm", "--filter", "@vendoai/bench", "demo:capture", "--",
          "demo-beats", "--host-config", appPath, "--run-id", runId, "--port", String(args.port + 1),
        ], { cwd: io.repoRoot });
        if (capture.code !== 0) {
          throw new Error(`demo-beats capture failed (exit ${capture.code}) — a declared beat did not deliver:\n${(capture.stderr || capture.stdout).slice(-3000)}`);
        }
        // The verification consumed the demo's own capped turns (VERIFY.md §5).
        await rm(path.join(appDir as string, ".vendo", "data", "demo-caps.json"), { force: true }).catch(() => undefined);
      });
      gifPath = path.join(io.repoRoot, "bench", "demo-capture", "output", runId, `demo-beats-${args.id}.gif`);
    }

    if (args.skipDeploy) {
      write("[pipeline] --skip-deploy: stopping after the local stages");
      return { appDir, appPath, timings, rewrite, judge, ...(gifPath === undefined ? {} : { gifPath }) };
    }

    const routerUrl = "https://demos.vendo.run";
    const deployArgs: DemoDeployArgs = { app: appPath, project: "vendo-demos", routerUrl, skipRegistry: false, dryRun: false };
    const deploy = await stage("deploy", async () => {
      // Known transient `railway up` TLS flake (BadRecordMac) — live runs
      // measured ~80% failure per attempt on a bad network night, so retry
      // with pauses; demo:deploy is idempotent and the 2h cap bounds the run.
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await stages.deploy(deployArgs, { repoRoot: io.repoRoot, write, exec });
        } catch (error) {
          write(`[pipeline] deploy attempt ${attempt} failed (${error instanceof Error ? error.message.split("\n")[0] : String(error)})`);
          if (attempt >= 6) throw error;
          await new Promise((resolve) => setTimeout(resolve, io.deployRetryWaitMs ?? 30_000));
        }
      }
    });

    const demoUrl = `${routerUrl}/${args.id}`;
    const gate = await stage("final-gate", () => stages.gate(
      {
        demoUrl,
        appDir: appDir as string,
        outDir: path.join(appDir as string, "RESEARCH", "gate"),
        demoPassword: demoPassword(args.id, process.env),
      },
      { write, signal: capSignal },
    ));

    return { appDir, appPath, timings, rewrite, judge, deploy, gate, demoUrl, ...(gifPath === undefined ? {} : { gifPath }) };
  } catch (error) {
    // Early-stage abort keeps the repo pristine. Parks (cap, judge) and later
    // stages keep the app dir — the evidence IS the park report's substance.
    if (appDir !== undefined && cleanupOnAbort && !(error instanceof DemoParkedError)) {
      await rm(appDir, { recursive: true, force: true }).catch(() => undefined);
    }
    throw error;
  } finally {
    clearTimeout(capTimer);
  }
}
