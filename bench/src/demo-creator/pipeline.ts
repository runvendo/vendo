import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, lstat, mkdir, readFile, readlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { runAssemble, type AssembleIo, type AssembleResult } from "./assemble.js";
import { runBrief, type BriefIo, type BriefResult } from "./brief.js";
import { buildBudgetCeilingUsd, runBuild, type BuildIo, type BuildResult } from "./build.js";
import { assertNoSymlinks, demoPaths, parseDemoSlug } from "./demo-folder.js";
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
  // ROUND-TRIP, not just "did Date accept it": `new Date("2026-02-30")` does not
  // throw, it rolls forward to March 2 — so a day that does not exist became an
  // expiry the operator never chose, silently, on a demo that then died on the
  // wrong date. Comparing the parse back against the input is what catches it.
  if (Number.isNaN(instant.getTime()) || instant.toISOString().slice(0, 10) !== value) {
    throw new Error(`--expires is not a real date: ${value}`);
  }
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
  // Validated HERE, at the operator boundary, before any stage builds a path
  // from it: the slug arrives from a Slack message and every stage joins it onto
  // one. demoPaths re-asserts it, so neither layer can be the only guard.
  parseDemoSlug(id);
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
 * Ignored paths that are infrastructure, not an escape: a vendo-demos checkout
 * that has ever run `pnpm install` or an assemble holds hundreds of thousands of
 * ignored files under these, and a fence that fired on them would throw on every
 * second run — which is how a safety check gets deleted rather than fixed.
 * Nothing under host/src or any demo folder is exempt.
 */
const ignoredInfrastructureDirs = new Set([
  "node_modules", ".next", ".turbo", ".git", ".cache", ".vercel", "dist", "build", "coverage",
]);

function isIgnoredInfrastructure(touched: string): boolean {
  return touched.split("/").some((segment) => ignoredInfrastructureDirs.has(segment));
}

/** Every dirty path outside `demos/<slug>/` that is not infrastructure — the
 * candidate escapes, before any baseline is subtracted. */
async function dirtyOutsideDemo(demosRepo: string, slug: string, io: { exec: ExecFn }): Promise<string[]> {
  const status = await io.exec(
    ["git", "-C", demosRepo, "status", "--porcelain", "--untracked-files=all", "--ignored"],
    { cwd: demosRepo },
  );
  if (status.code !== 0) {
    throw new Error(`cannot fence the demos repo: "git status" failed (exit ${status.code}): ${status.stderr.trim() || status.stdout.trim()}`);
  }
  const allowed = `demos/${slug}/`;
  return [...new Set(status.stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .flatMap(porcelainPaths)
    .filter((touched) => !touched.startsWith(allowed) && !isIgnoredInfrastructure(touched)))];
}

/**
 * What a path held at snapshot time. A HASH rather than mere presence, because
 * the paths that are legitimately already dirty are `host/src/generated/
 * manifest.ts` and friends — host SOURCE that compiles into the shared host. If
 * "already dirty" meant "no longer watched", an agent appending one import to
 * the manifest would be the one escape the fence could not see.
 */
async function contentId(demosRepo: string, relative: string): Promise<string> {
  try {
    const target = path.join(demosRepo, relative);
    // lstat, never stat: following a link reads outside the repo, and
    // `host/x -> /dev/zero` is an unbounded read — a hang where the fence owes a
    // refusal. A link's TARGET is its identity, so re-pointing one is a change.
    const info = await lstat(target);
    if (info.isSymbolicLink()) return `symlink:${await readlink(target)}`;
    if (info.isDirectory()) return "dir";
    if (!info.isFile()) return `special:${info.mode}`;
    return createHash("sha256").update(await readFile(target)).digest("hex");
  } catch {
    // Gone, unreadable, or a dangling link. Recorded as a value like any other,
    // so a path that is absent at snapshot time and readable later is an escape.
    return "absent";
  }
}

/** Paths outside the demo folder that were ALREADY dirty when the agents
 * started, and the content they held then. */
export type HostBaseline = Map<string, string>;

/**
 * The state of the checkout immediately BEFORE the build agents run.
 *
 * Without this the fence measured all-time dirtiness, so it fired on the
 * PREVIOUS run's gitignored artifacts and `demo:pipeline` worked exactly once
 * per checkout — and the mini's `~/.vendo/vendo-demos` is a checkout that lives
 * forever, so the Slack driver would have served the first demo request ever and
 * failed every one after it.
 */
export async function snapshotHostBaseline(
  demosRepo: string,
  slug: string,
  io: { exec: ExecFn },
): Promise<HostBaseline> {
  const dirty = await dirtyOutsideDemo(demosRepo, slug, io);
  return new Map(await Promise.all(dirty.map(async (touched): Promise<[string, string]> =>
    [touched, await contentId(demosRepo, touched)])));
}

/**
 * The runtime fence behind the contract's "generation agents never write
 * host/". The agents' own harness now denies writes outside the demo folder
 * (agent.ts's settings sandbox), and this is the second line: it catches
 * anything the CLI's permission layer let through, and `railway up` uploads the
 * whole WORKING DIRECTORY, not the commit — so a stray edit to the Vendo kit or
 * the caps guard would reach every live demo without ever being reviewed.
 *
 * Scoped to the AGENT WINDOW, not to all-time dirtiness: `baseline` is the same
 * listing taken before the agents started, and a path is an offence only if it
 * is new or changed against it. That is the fence's own claim read honestly — "an
 * AGENT wrote this" — and it is what makes the pipeline runnable twice, since the
 * pipeline's OWN later stages write host/src/generated/manifest.ts,
 * host/public/brand/<slug>/ and host/next-env.d.ts, which then survive the run.
 * An empty baseline (the default) means no excuses, so a caller that forgets to
 * snapshot fails closed rather than getting a silently disarmed fence.
 *
 * Two blind spots the porcelain default has, both proven exploitable:
 *  - IGNORED files are omitted entirely, so `host/src/vendo-kit/evil.local`
 *    passed. Hence `--ignored`, minus the infrastructure above.
 *  - a SYMLINK inside the demo folder is not outside the demo folder, so no
 *    path check can see it. Hence {@link assertNoSymlinks}.
 *
 * Called at the two points where an agent has just run (pipeline: after build;
 * fix: after the fix agent and its tool re-sync).
 */
export async function assertOnlyDemoTouched(
  demosRepo: string,
  slug: string,
  io: { exec: ExecFn },
  baseline: HostBaseline = new Map(),
): Promise<void> {
  await assertNoSymlinks(demoPaths(demosRepo, slug).root, slug);
  const dirty = await dirtyOutsideDemo(demosRepo, slug, io);
  const offenders: string[] = [];
  for (const touched of dirty) {
    const before = baseline.get(touched);
    if (before !== undefined && before === await contentId(demosRepo, touched)) continue;
    offenders.push(touched);
  }
  if (offenders.length > 0) {
    throw new Error(
      `generation agents wrote outside demos/${slug}/: ${offenders.join(", ")} — the host is not theirs to edit, and \`railway up\` uploads the working directory, so these would reach every live demo uncommitted. Inspect and revert them by hand (git -C ${demosRepo} checkout -- <path>, or delete an untracked one), then re-run.`,
    );
  }
}

/**
 * Puts demos/<slug>/ back the way git has it after a FAILED run, keeping what the
 * run produced outside the checkout for diagnosis.
 *
 * Why a failed run cannot just be left where it fell: the host's gen-manifest
 * validates EVERY demo folder and writes nothing unless all of them pass. So one
 * half-generated leftover — no tools.json, an illegible theme — does not fail its
 * own run twice, it fails every LATER run in that checkout. The mini's
 * `~/.vendo/vendo-demos` lives forever, so one bad run bricked the Slack driver
 * until a human moved the folder aside by hand.
 *
 * git decides what "clean" means, which is what makes this safe for demo:fix: a
 * fix run works on a demo that is already live and COMMITTED, and the checkout
 * plus clean restores that demo rather than deleting it. Only a demo this run
 * created is untracked, and only an untracked folder disappears.
 *
 * Never throws. It runs on the failure path with a real cause already travelling
 * to the operator, and replacing that cause with a cleanup detail is the worst
 * trade available.
 */
export async function quarantineFailedDemo(options: {
  demosRepo: string;
  slug: string;
  exec: ExecFn;
  write: (line: string) => void;
  /** Overridable so a test can see where things went. */
  quarantineRoot?: string;
}): Promise<{ quarantined?: string }> {
  // demoPaths re-asserts the slug, so no caller can aim `git clean` with it.
  const root = demoPaths(options.demosRepo, options.slug).root;
  if (!existsSync(root)) return {};
  const pathspec = `demos/${options.slug}`;
  let quarantined: string | undefined;
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    quarantined = path.join(
      options.quarantineRoot ?? path.join(tmpdir(), "vendo-demo-failed"),
      `${options.slug}-${stamp}`,
    );
    // Copied out BEFORE anything is removed: a failed run's folder is the only
    // record of what the agents actually produced.
    await cp(root, quarantined, { recursive: true, verbatimSymlinks: true });
    // Tracked files first (a failed fix run's edits), then whatever is untracked.
    // The checkout legitimately exits non-zero when nothing here is tracked —
    // that is the new-demo case, and the clean below is what handles it.
    await options.exec(["git", "-C", options.demosRepo, "checkout", "--", pathspec], { cwd: options.demosRepo });
    const cleaned = await options.exec(["git", "-C", options.demosRepo, "clean", "-ffdxq", "--", pathspec], { cwd: options.demosRepo });
    if (cleaned.code !== 0) {
      throw new Error(`git clean exited ${cleaned.code}: ${cleaned.stderr.trim() || cleaned.stdout.trim()}`);
    }
    options.write(`[pipeline] the failed demo folder was moved out of the checkout to ${quarantined} — the next run starts from a clean ${pathspec}`);
  } catch (error) {
    options.write(
      `[pipeline] WARNING: could not clean up demos/${options.slug}/ after the failure (${error instanceof Error ? error.message : String(error)})`
      + ` — gen-manifest validates EVERY demo folder, so remove it by hand before the next run: rm -rf ${root}`,
    );
  }
  return quarantined === undefined ? {} : { quarantined };
}

/**
 * One row of RESEARCH/timings.json — the per-stage wall-clock evidence.
 *
 * `depth` is what makes the table summable. Stages NEST: judge.ts wraps its body
 * in the same runStage the pipeline wrapped the judge stage in, and assemble
 * contributes install/gen-manifest/build/boot/smoke rows inside its own. Adding
 * every `ms` therefore counts the nested time twice; summing the rows with
 * `depth: 0` is the run's real wall clock.
 */
export interface StageTiming {
  stage: string;
  startedAt: string;
  ms: number;
  /** 0 = a top-level stage; 1+ = a sub-stage inside the row above it. */
  depth: number;
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
  /** Measured generation-agent spend for this run (the claude CLI reports it). */
  costUsd: number;
  judge: JudgeResult;
  scoresLine: string;
  /** Absent with --skip-ship. */
  ship?: ShipResult;
  liveUrl?: string;
}

/**
 * The timings file, and the one moment it stops being written.
 *
 * RESEARCH/timings.json lives INSIDE the folder ship commits, so the stage
 * runner's own post-stage write used to land AFTER `git add`: the committed
 * evidence under-reported the run, and the run ended with demos/<slug> modified
 * — dirt a long-lived checkout keeps forever and the next slug's run inherits.
 * {@link finalize} is therefore called immediately before staging, and nothing
 * writes the file again. The deploy rows (`ship`, `ship:railway`, `ship:live`)
 * live on in the run's result and stdout: a file that is inside the commit
 * cannot record how long committing it took.
 */
export function createTimingsFile(options: {
  timings: StageTiming[];
  file: string;
  write: (line: string) => void;
}): { flush: () => Promise<void>; finalize: () => Promise<void> } {
  let sealed = false;
  const flush = async (): Promise<void> => {
    if (sealed) return;
    try {
      await mkdir(path.dirname(options.file), { recursive: true });
      await writeFile(options.file, `${JSON.stringify(options.timings, null, 2)}\n`);
    } catch (error) {
      // Never fatal — timings are the evidence, not the product — but never
      // silent either: a swallowed failure left the file absent, stale or
      // truncated and the run shipped it as if it were the record.
      options.write(`[pipeline] WARNING: could not write ${options.file} (${error instanceof Error ? error.message : String(error)}) — the stage timings for this run are incomplete`);
    }
  };
  return {
    flush,
    finalize: async () => {
      await flush();
      sealed = true;
    },
  };
}

/** The stage runner: timings, markers, and a cap that TERMINATES rather than
 * merely stops awaiting. */
export function createStageRunner(options: {
  timings: StageTiming[];
  /** Persists the timings appended so far — {@link createTimingsFile}'s flush,
   * which goes quiet once ship has committed the file. */
  writeTimings: () => Promise<void>;
  write: (line: string) => void;
  deadline: number;
  signal: AbortSignal;
  capFired: (context: string) => Error;
}) {
  const counts = new Map<string, number>();
  let depth = 0;
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
    const rowDepth = depth;
    depth += 1;
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
      depth = rowDepth;
      const ms = Math.round(performance.now() - t0);
      options.timings.push({ stage: rowName, startedAt, ms, depth: rowDepth });
      options.write(`[pipeline] ${rowName} finished in ${ms}ms`);
      await options.writeTimings();
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

  const timingsFile = createTimingsFile({ timings, file: paths.timings, write });
  const runStage = createStageRunner({
    timings,
    // The demo folder does not exist until the evidence stage creates it; the
    // repo stage's row lands on the next write.
    writeTimings: timingsFile.flush,
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

    // The checkout as it stands BEFORE any agent runs. Taken as late as possible
    // — evidence and the brief write only inside the demo folder — so the window
    // it excuses is exactly the agents' own.
    const hostBaseline = await snapshotHostBaseline(args.demosRepo, args.id, { exec });

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
    // outside the demo folder can ONLY have come from a build agent — which is
    // what the baseline makes precise, rather than trusting the checkout to have
    // arrived clean.
    await assertOnlyDemoTouched(args.demosRepo, args.id, { exec }, hostBaseline);

    // The smoke turn plays the demo's OWN first beat: if the beat a prospect
    // will click errors or never settles, the demo is broken regardless of how
    // it looks. Content is not judged here (that is stage 5's job).
    const smokePrompt = built.beats[0]?.prompt ?? `Show me an overview of the ${args.prospect} data in this workspace.`;
    const assembled = await runStage("assemble", () => stages.assemble(
      { slug: args.id, port: localHostPort, smokePrompt },
      { demosRepo: args.demosRepo, write, env, exec, signal, runStage },
    ));
    host = assembled.host;

    // What the run actually cost, next to what it was allowed to: the agents are
    // the only unbounded spend in a run, and `--max-budget-usd` is the only
    // thing that stops one from looping. Printed before ship so it is visible
    // even on a run that fails later.
    write(`SPEND: $${built.costUsd.toFixed(2)} on ${built.agents.length} generation agent run(s) (cap $${buildBudgetCeilingUsd.toFixed(2)}); the brief, chip and judge model calls are not priced by the harness`);

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
      return { slug: args.id, demoDir: paths.root, timings, judge, scoresLine, costUsd: built.costUsd };
    }

    const shipped = await runStage("ship", () => stages.ship(
      { slug: args.id, prospect: args.prospect },
      { demosRepo: args.demosRepo, write, env, exec, signal, runStage, finalizeTimings: timingsFile.finalize },
    ));
    return { slug: args.id, demoDir: paths.root, timings, judge, scoresLine, costUsd: built.costUsd, ship: shipped, liveUrl: shipped.liveUrl };
  } catch (error) {
    // A failed run does not get to leave its half-built folder behind: the host's
    // gen-manifest validates EVERY demo, so this run's wreckage would fail the
    // NEXT run in the same checkout, and the mini's checkout is permanent.
    await quarantineFailedDemo({ demosRepo: args.demosRepo, slug: args.id, exec, write });
    throw error;
  } finally {
    clearTimeout(capTimer);
    // One dev server, reaped by whoever started it — including on the failure
    // path, where an orphaned host would hold the port for every later run.
    if (host !== undefined) await stopHost(host);
  }
}
