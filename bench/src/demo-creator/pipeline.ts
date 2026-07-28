import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { runAssemble, type AssembleIo, type AssembleResult } from "./assemble.js";
import { runBrief, type BriefIo, type BriefResult } from "./brief.js";
import { runBuild, type BuildIo, type BuildResult } from "./build.js";
import { demoPaths } from "./demo-folder.js";
import { defaultDemosRepo, ensureDemosRepo } from "./demos-repo.js";
import { runEvidence, type EvidenceIo, type EvidenceResult } from "./evidence.js";
import { defaultExec, type ExecFn } from "./exec.js";
import { runJudge, type JudgeIo, type JudgeResult } from "./judge.js";
import { runShip, type ShipIo, type ShipResult } from "./ship.js";

/**
 * `demo:pipeline` — Slack screenshots to a live demo in one command.
 *
 * Six stages, each writing into ONE demo folder inside the vendo-demos host
 * repo: evidence → brief → build → assemble → judge → ship. Two properties no
 * individual stage can give:
 *
 *  - Per-stage observability: every stage appends {stage, startedAt, ms} to
 *    RESEARCH/timings.json and logs a one-line marker — the empirical basis
 *    for the 20-minute budget.
 *  - One machine-readable outcome: `LIVE: <url>` on success (exit 0),
 *    `FAILED: <one-line cause>` otherwise (non-zero). The Slack driver reads
 *    exactly those two lines, plus `SCORES: ...`.
 */

/** Local port for the assemble/judge boot — never 3000 (the capture harness
 * holds a shared lock on it). Not a flag: the operator surface is deliberately
 * three arguments wide. */
export const localHostPort = 3150;

/** How long a run may take before it gives up. The target is 20 minutes; this
 * is the outer bound that stops a wedged `railway up` from running all night. */
export const defaultCapMs = 40 * 60 * 1000;

/** Days from now a generated demo expires when --expires is not given. */
const defaultExpiryDays = 21;

export interface DemoPipelineArgs {
  id: string;
  prospect: string;
  /** Absolute paths to the operator's reference screenshots. At least one. */
  screenshots: string[];
  url?: string;
  ctaUrl: string;
  /** UTC instant, derived from --expires (a date) or defaulted 21 days out. */
  expiresAt: string;
  /** PATH to the operator's notes file. Its CONTENTS become the brief's
   * authoritative operator note — {@link readOperatorNotes} reads it. */
  notes?: string;
  demosRepo: string;
  /** Stop after judge: nothing is committed, pushed or deployed. */
  skipShip: boolean;
}

const valueOptions = new Set(["--id", "--prospect", "--screenshots", "--url", "--cta-url", "--expires", "--notes", "--demos-repo"]);
const flagOptions = new Set(["--skip-ship"]);

/** `--expires 2026-08-31` → the UTC instant demo.config.json wants. */
export function parseExpires(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`--expires must be a plain date, e.g. 2026-08-31 (received ${value})`);
  }
  const instant = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(instant.getTime())) throw new Error(`--expires is not a real date: ${value}`);
  return instant.toISOString();
}

export function defaultExpiresAt(now = new Date()): string {
  return new Date(now.getTime() + defaultExpiryDays * 24 * 60 * 60 * 1000).toISOString();
}

export function parseDemoPipelineArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): DemoPipelineArgs {
  const normalizedArgv = argv[0] === "--" ? argv.slice(1) : argv;
  const options = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < normalizedArgv.length; index += 1) {
    const option = normalizedArgv[index];
    if (option?.startsWith("--") !== true) throw new Error(`Unexpected argument: ${option ?? ""}`);
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
  if (id === undefined) throw new Error("--id is required (the demo slug)");
  const prospect = options.get("--prospect");
  if (prospect === undefined) throw new Error("--prospect is required");
  const rawScreenshots = options.get("--screenshots");
  if (rawScreenshots === undefined) {
    throw new Error("--screenshots is required (comma-separated absolute paths to the prospect's real product screenshots)");
  }
  const screenshots = rawScreenshots.split(",").map((entry) => entry.trim()).filter((entry) => entry !== "");
  if (screenshots.length === 0) throw new Error("--screenshots needs at least one image path (comma-separated)");
  const expires = options.get("--expires");
  const url = options.get("--url");
  const notes = options.get("--notes");
  return {
    id,
    prospect,
    screenshots,
    ctaUrl: options.get("--cta-url") ?? "https://cal.com/yousefhelal",
    expiresAt: expires === undefined ? defaultExpiresAt() : parseExpires(expires),
    demosRepo: options.get("--demos-repo") ?? defaultDemosRepo(env),
    skipShip: flags.has("--skip-ship"),
    ...(url === undefined ? {} : { url }),
    ...(notes === undefined ? {} : { notes }),
  };
}

/**
 * Fails a run in the first second rather than the fifteenth minute.
 *
 * Every credential here is needed by a LATER stage, and each one fails in a
 * shape that looks like a demo problem instead of a setup problem: no
 * ANTHROPIC_API_KEY and the brief's vision call 401s; no key on the host and
 * the smoke turn dies as a "hard error", losing a demo that was fine.
 */
export function preflight(env: NodeJS.ProcessEnv): void {
  const missing: string[] = [];
  if ((env.ANTHROPIC_API_KEY ?? "") === "") missing.push("ANTHROPIC_API_KEY (the brief, the judge and the claude CLI build agents)");
  if ((env.CONTEXT_DEV_API_KEY ?? "") === "") missing.push("CONTEXT_DEV_API_KEY (brand evidence — in Infisical)");
  // The demo host runs the Cloud posture (store and connections slots unset,
  // Cloud composes them), so the boot that answers the smoke turn needs the
  // host's OWN key — the harness key does not stand in for it.
  if ((env.VENDO_API_KEY ?? "") === "") missing.push("VENDO_API_KEY (the locally booted host — its store, connections and agent route are Cloud-composed)");
  if (missing.length > 0) {
    throw new Error(`missing credential(s): ${missing.join("; ")} — source the Flowlet .env before running`);
  }
}

/**
 * `--notes` is a FILE PATH whose CONTENTS become the brief's authoritative
 * operator note. Read here rather than in the parser so parsing stays sync, and
 * hard-failed rather than defaulted: a typo'd path is operator input exactly
 * like `--screenshots`, and passing the path through would make the string
 * "notes.md" the note that wins every conflict in the brief.
 */
async function readOperatorNotes(file: string): Promise<string> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    throw new Error(`--notes: cannot read the operator notes file "${file}": ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** One porcelain line → the repo-relative paths it touches. A rename reports
 * BOTH halves (`R  old -> new`), and each half is its own touched path. */
function porcelainPaths(line: string): string[] {
  // Two status columns then a space; everything after is path(s).
  const rest = line.slice(3);
  const arrow = rest.indexOf(" -> ");
  return (arrow === -1 ? [rest] : [rest.slice(0, arrow), rest.slice(arrow + 4)])
    .map((entry) => entry.trim())
    // git quotes any path holding a space or a non-ASCII byte. The prefix this
    // fence tests is plain ASCII, so unwrapping the quotes is enough — read raw,
    // a demo's own "screens/Invoice Table.tsx" would look like an escape.
    .map((entry) => (entry.startsWith('"') && entry.endsWith('"') ? entry.slice(1, -1) : entry))
    .filter((entry) => entry !== "");
}

/**
 * The runtime fence behind the contract's "generation agents never write
 * host/". The build and fix agents run with `--permission-mode
 * bypassPermissions`, so the prompt's file list is a request, not a boundary —
 * and `railway up` uploads the whole WORKING DIRECTORY, not the commit. A stray
 * edit to the Vendo kit or the caps guard would therefore reach every live demo
 * without ever being committed or reviewed.
 *
 * Called at the two points where an agent has just run and nothing legitimate
 * has yet written outside the demo folder (gen-manifest's manifest.ts and the
 * host's brand assets come later, in assemble).
 */
export async function assertOnlyDemoTouched(
  demosRepo: string,
  slug: string,
  io: { exec: ExecFn },
): Promise<void> {
  const status = await io.exec(["git", "-C", demosRepo, "status", "--porcelain", "--untracked-files=all"], { cwd: demosRepo });
  if (status.code !== 0) {
    throw new Error(`cannot fence the demos repo: "git status" failed (exit ${status.code}): ${status.stderr.trim() || status.stdout.trim()}`);
  }
  const allowed = `demos/${slug}/`;
  const offenders = status.stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .flatMap(porcelainPaths)
    .filter((touched) => !touched.startsWith(allowed));
  if (offenders.length > 0) {
    throw new Error(
      `generation agents wrote outside demos/${slug}/: ${[...new Set(offenders)].join(", ")} — the host is not theirs to edit, and \`railway up\` uploads the working directory, so these would reach every live demo uncommitted. Inspect and revert them by hand (git -C ${demosRepo} checkout -- <path>, or delete an untracked one), then re-run.`,
    );
  }
}

/** One row of RESEARCH/timings.json — the per-stage wall-clock evidence. */
export interface StageTiming {
  stage: string;
  startedAt: string;
  ms: number;
}

/** Stage seams so unit tests drive the pipeline without a model, a browser or
 * Railway. Each entry is the stage module's own entry point. */
export interface PipelineStages {
  ensureRepo: typeof ensureDemosRepo;
  evidence: (args: Parameters<typeof runEvidence>[0], io: EvidenceIo) => Promise<EvidenceResult>;
  brief: (args: Parameters<typeof runBrief>[0], io: BriefIo) => Promise<BriefResult>;
  build: (args: Parameters<typeof runBuild>[0], io: BuildIo) => Promise<BuildResult>;
  assemble: (args: Parameters<typeof runAssemble>[0], io: AssembleIo) => Promise<AssembleResult>;
  judge: (args: Parameters<typeof runJudge>[0], io: JudgeIo) => Promise<JudgeResult>;
  ship: (args: Parameters<typeof runShip>[0], io: ShipIo) => Promise<ShipResult>;
}

const defaultStages: PipelineStages = {
  ensureRepo: ensureDemosRepo,
  evidence: runEvidence,
  brief: runBrief,
  build: runBuild,
  assemble: runAssemble,
  judge: runJudge,
  ship: runShip,
};

export interface PipelineIo {
  stages?: PipelineStages;
  exec?: ExecFn;
  write?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  /** Wall-clock hard cap; past it no further stage starts and in-flight
   * children are killed through the threaded signal. */
  capMs?: number;
}

export interface DemoPipelineResult {
  slug: string;
  demoDir: string;
  timings: StageTiming[];
  judge: JudgeResult;
  scoresLine: string;
  /** Absent with --skip-ship. */
  ship?: ShipResult;
  liveUrl?: string;
}

/** The stage runner: timings, markers, and a cap that TERMINATES rather than
 * merely stops awaiting. */
export function createStageRunner(options: {
  timings: StageTiming[];
  timingsPath: () => string | undefined;
  write: (line: string) => void;
  deadline: number;
  signal: AbortSignal;
  capFired: (context: string) => Error;
}) {
  const counts = new Map<string, number>();
  return async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    if (Date.now() > options.deadline) throw options.capFired(`before stage "${name}"`);
    // Distinct row per occurrence: a repeated name (judge.ts wraps its own body
    // in runStage("judge"), the same name the pipeline gives the stage) gets
    // "#n" so the timing table stays one honest row per thing that ran.
    const count = (counts.get(name) ?? 0) + 1;
    counts.set(name, count);
    const rowName = count === 1 ? name : `${name}#${count}`;
    const startedAt = new Date().toISOString();
    const t0 = performance.now();
    options.write(`[pipeline] ${rowName} started`);
    let onAbort: (() => void) | undefined;
    try {
      const capRace = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(options.capFired(`during stage "${rowName}"`));
        if (options.signal.aborted) onAbort();
        else options.signal.addEventListener("abort", onAbort, { once: true });
      });
      const stagePromise = fn();
      // The aborted stage's own late rejection (killed subprocess) is expected
      // noise once the cap has won the race.
      void stagePromise.catch(() => undefined);
      return await Promise.race([stagePromise, capRace]);
    } finally {
      if (onAbort !== undefined) options.signal.removeEventListener("abort", onAbort);
      const ms = Math.round(performance.now() - t0);
      options.timings.push({ stage: rowName, startedAt, ms });
      options.write(`[pipeline] ${rowName} finished in ${ms}ms`);
      const target = options.timingsPath();
      if (target !== undefined) {
        await mkdir(path.dirname(target), { recursive: true }).catch(() => undefined);
        await writeFile(target, `${JSON.stringify(options.timings, null, 2)}\n`).catch(() => undefined);
      }
    }
  };
}

const plannedStages = ["repo", "evidence", "brief", "build", "assemble", "judge", "ship"];

export async function runDemoPipeline(args: DemoPipelineArgs, io: PipelineIo = {}): Promise<DemoPipelineResult> {
  const stages = io.stages ?? defaultStages;
  const write = io.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const env = io.env ?? process.env;
  const paths = demoPaths(args.demosRepo, args.id);

  const capController = new AbortController();
  const signal = capController.signal;
  const baseExec = io.exec ?? defaultExec;
  const exec: ExecFn = (command, options) => baseExec(command, { signal, ...options });

  const timings: StageTiming[] = [];
  const capMs = io.capMs ?? defaultCapMs;
  const deadline = Date.now() + capMs;
  const capTimer = setTimeout(
    () => capController.abort(new Error(`the ${Math.round(capMs / 60000)}-minute wall-clock cap fired`)),
    Math.max(0, capMs),
  );
  capTimer.unref?.();

  const capFired = (context: string): Error => {
    // Top-level rows only: the sub-stage rows the stages contribute would drown
    // out the one thing this line exists to say.
    const done = plannedStages.filter((planned) => timings.some((row) => row.stage === planned));
    const remaining = plannedStages.filter((planned) => !done.includes(planned));
    return new Error(
      `the ${Math.round(capMs / 60000)}-minute wall-clock cap fired ${context} — completed: ${done.join(", ") || "(none)"}; not run: ${remaining.join(", ")}`,
    );
  };

  const runStage = createStageRunner({
    timings,
    // The demo folder does not exist until the evidence stage creates it; the
    // repo stage's row lands on the next write.
    timingsPath: () => paths.timings,
    write,
    deadline,
    signal,
    capFired,
  });

  // A failed stop leaks `next start` on the port and the NEXT run dies with a
  // boot error that looks like nothing to do with this one — so it is a loud
  // warning, never a swallow.
  const stopHost = async (running: AssembleResult["host"]): Promise<void> => {
    try {
      await running.stop();
    } catch (error) {
      write(`[pipeline] WARNING: the local host on port ${localHostPort} did not stop (${error instanceof Error ? error.message : String(error)}) — kill it before the next run: lsof -ti:${localHostPort} | xargs kill -9`);
    }
  };

  let host: AssembleResult["host"] | undefined;
  try {
    // Operator input, read before anything is spent: a typo'd --notes path must
    // not surface fifteen minutes later, or worse, silently become the note.
    const notes = args.notes === undefined ? undefined : await readOperatorNotes(args.notes);

    await runStage("repo", () => stages.ensureRepo(args.demosRepo, { exec, write, signal }));

    const evidence = await runStage("evidence", () => stages.evidence(
      {
        slug: args.id,
        prospect: args.prospect,
        screenshots: args.screenshots,
        ...(args.url === undefined ? {} : { url: args.url }),
      },
      { demosRepo: args.demosRepo, write },
    ));

    const brief = await runStage("brief", () => stages.brief(
      {
        slug: args.id,
        prospect: args.prospect,
        ...(args.url === undefined ? {} : { url: args.url }),
        ...(notes === undefined ? {} : { notes }),
      },
      { demosRepo: args.demosRepo, write, env, evidence },
    ));

    const built = await runStage("build", () => stages.build(
      {
        slug: args.id,
        prospect: args.prospect,
        ctaUrl: args.ctaUrl,
        expiresAt: args.expiresAt,
        brief: brief.brief,
        theme: brief.theme,
      },
      { demosRepo: args.demosRepo, write, env, exec, signal, runStage },
    ));

    // Between build and assemble is the only window where a working-tree change
    // outside the demo folder can ONLY have come from a build agent.
    await assertOnlyDemoTouched(args.demosRepo, args.id, { exec });

    // The smoke turn plays the demo's OWN first beat: if the beat a prospect
    // will click errors or never settles, the demo is broken regardless of how
    // it looks. Content is not judged here (that is stage 5's job).
    const smokePrompt = built.beats[0]?.prompt ?? `Show me an overview of the ${args.prospect} data in this workspace.`;
    const assembled = await runStage("assemble", () => stages.assemble(
      { slug: args.id, port: localHostPort, smokePrompt },
      { demosRepo: args.demosRepo, write, env, exec, signal, runStage },
    ));
    host = assembled.host;

    const judge = await runStage("judge", () => stages.judge(
      { slug: args.id, prospect: args.prospect, baseUrl: assembled.host.baseUrl },
      { demosRepo: args.demosRepo, write, signal, runStage },
    ));
    const scoresLine = judge.scoresLine;
    write(`SCORES: ${scoresLine}`);

    // Free the port before the ship stage: nothing after this needs the local
    // host, and a leaked `next start` would hold 3150 for the next run.
    await stopHost(host);
    host = undefined;

    if (args.skipShip) {
      write("[pipeline] --skip-ship: stopping after judge (nothing committed, pushed or deployed)");
      return { slug: args.id, demoDir: paths.root, timings, judge, scoresLine };
    }

    const shipped = await runStage("ship", () => stages.ship(
      { slug: args.id, prospect: args.prospect },
      { demosRepo: args.demosRepo, write, env, exec, signal, runStage },
    ));
    return { slug: args.id, demoDir: paths.root, timings, judge, scoresLine, ship: shipped, liveUrl: shipped.liveUrl };
  } finally {
    clearTimeout(capTimer);
    // One dev server, reaped by whoever started it — including on the failure
    // path, where an orphaned host would hold the port for every later run.
    if (host !== undefined) await stopHost(host);
  }
}
