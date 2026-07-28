import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { hostDir } from "./demo-folder.js";
import { defaultExec, firstLine, type ExecFn } from "./exec.js";
import {
  bootHost,
  buildHost,
  defaultHostCommands,
  defaultSmokeTurn,
  generateManifest,
  type HostCommands,
  type RunningHost,
  type SmokeTurnFn,
} from "./host-boot.js";
import { smokeBudgetMs, type SmokeOutcome, type SmokeProgress, type SmokeVerdict } from "./smoke.js";

/**
 * Stage 4 — assemble. The gate that keeps a broken demo off demos.vendo.run:
 * the host must discover the new demo, compile it, boot, and survive ONE real
 * agent turn. The turn's CONTENT is not judged here (that is stage 5) — only
 * hard failure.
 *
 * "Hard failure" is the whole subtlety, and it used to be one 180s deadline. See
 * smoke.ts for the measured latencies that made that a coin flip; this stage now
 * asks the two questions separately — is the agent BROKEN (fail on the signal, in
 * seconds), or merely SLOW (let it finish inside a budget healthy turns cannot
 * reach) — and reports the two outcomes as different things.
 */

export interface AssembleArgs {
  slug: string;
  port: number;
  /** The beat prompt to smoke with. */
  smokePrompt: string;
}

export interface AssembleIo {
  demosRepo: string;
  exec?: ExecFn;
  write?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  commands?: HostCommands;
  smokeTurn?: SmokeTurnFn;
  boot?: typeof bootHost;
  runStage?: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
}

export interface AssembleResult {
  slugs: string[];
  /** The booted host, still running — the CALLER stops it (the judge screenshots
   *  the same boot; a second boot would cost minutes of the 20-minute budget). */
  host: RunningHost;
  smoke: {
    prompt: string;
    ms: number;
    verdict: SmokeVerdict;
    /** Liveness only — never content. See {@link SmokeProgress}. */
    progress: SmokeProgress;
    /** 1, or 2 when the first attempt failed on a signal from outside the demo. */
    attempts: number;
  };
}

/**
 * The generated demo's agent does not work. This is what the gate exists to
 * catch, and it is the verdict that means "do not ship this".
 */
export class SmokeBrokenError extends Error {
  constructor(reason: string, readonly progress: SmokeProgress) {
    super(`the generated demo's agent is BROKEN — ${reason}`);
    this.name = "SmokeBrokenError";
  }
}

/**
 * The agent was demonstrably running and still did not finish inside a budget no
 * measured healthy turn comes near. Its own class, and its own prose, so nothing
 * downstream reports a demo that compiled, booted and streamed as broken — a turn
 * this slow is not demoable, but it is not the same finding.
 */
export class SmokeTimeoutError extends Error {
  constructor(ms: number, reason: string, readonly progress: SmokeProgress) {
    super(`the smoke turn TIMED OUT after ${ms}ms — ${reason}`);
    this.name = "SmokeTimeoutError";
  }
}

/** A cold `pnpm install` + `next build` runs for minutes. Generous but bounded:
 * a hang has to surface as a failure, not eat the whole pipeline budget. */
const bootTimeoutMs = 180_000;

export async function runAssemble(args: AssembleArgs, io: AssembleIo): Promise<AssembleResult> {
  const exec = io.exec ?? defaultExec;
  const write = io.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const commands = io.commands ?? defaultHostCommands;
  const boot = io.boot ?? bootHost;
  const smokeTurn = io.smokeTurn ?? defaultSmokeTurn;
  const runStage = io.runStage ?? (async <T>(_name: string, fn: () => Promise<T>): Promise<T> => await fn());
  const host = path.join(io.demosRepo, hostDir);
  const signalOption = io.signal === undefined ? {} : { signal: io.signal };
  const envOption = io.env === undefined ? {} : { env: io.env };

  // Installing costs minutes and the checkout is long-lived, so it happens only
  // when the host has never been installed. Lane 6's push is what changes deps,
  // and a dep change lands with an install of its own.
  if (existsSync(path.join(host, "node_modules"))) {
    write("[assemble] host/node_modules present — skipping install");
  } else {
    await runStage("assemble:install", async () => {
      write(`[assemble] installing the host (${commands.install.join(" ")})`);
      const result = await exec(commands.install, { cwd: host, ...signalOption, ...envOption });
      if (result.code !== 0) {
        throw new Error(`host install failed (exit ${result.code}): ${firstLine(result.stderr || result.stdout) ?? "no output"}`);
      }
    });
  }

  const { slugs } = await runStage("assemble:gen-manifest", async () => await generateManifest({
    demosRepo: io.demosRepo,
    exec,
    write,
    commands,
    ...signalOption,
  }));
  // A demo the manifest never imported is a demo the host cannot serve: its
  // page would 404 in front of the prospect. Fail here, before the build.
  if (!slugs.includes(args.slug)) {
    throw new Error(`gen-manifest did not discover "${args.slug}" (found: ${slugs.join(", ") || "none"}) — the host would 404 on /${args.slug}`);
  }

  await runStage("assemble:build", async () => await buildHost({
    demosRepo: io.demosRepo,
    exec,
    write,
    commands,
    ...signalOption,
    ...envOption,
  }));

  const running = await runStage("assemble:boot", async () => await boot({
    demosRepo: io.demosRepo,
    port: args.port,
    // Outside the demo folder on purpose: a server log is not demo content and
    // must never be committed to vendo-demos.
    logFile: path.join(tmpdir(), `vendo-assemble-${args.slug}.log`),
    timeoutMs: bootTimeoutMs,
    commands,
    ...envOption,
  }));

  const startedAt = Date.now();
  const attempt = async (): Promise<SmokeOutcome> => await runStage("assemble:smoke", async () => await smokeTurn({
    baseUrl: running.baseUrl,
    slug: args.slug,
    prompt: args.smokePrompt,
    timeoutMs: smokeBudgetMs,
  }));

  let outcome: SmokeOutcome;
  let attempts = 1;
  try {
    outcome = await attempt();
    // ONE retry, and only for an outcome a signal produced rather than the clock.
    // Run E lost a fine demo to "the response didn't finish" at 129s — an
    // external inference failure, which is not this demo's bug. Bounded at one:
    // an error that reproduces is a real bug, and these outcomes arrive in
    // seconds, so the retry costs seconds of wall clock and one turn against the
    // demo's own 20-turn cap. A DEADLINE is never retried: that would cost
    // another whole budget inside a 40-minute cap and re-prove nothing.
    if (outcome.verdict !== "settled" && outcome.retryable) {
      write(`[assemble] the smoke turn failed on something that can come from outside the demo (${outcome.reason ?? outcome.verdict}) — retrying ONCE`);
      attempts = 2;
      outcome = await attempt();
    }
  } catch (error) {
    // One dev server, no orphans: the host only survives a SUCCESSFUL smoke.
    await running.stop();
    throw error;
  }
  const ms = Date.now() - startedAt;

  if (outcome.verdict !== "settled") {
    // Loud and machine-readable before the throw, so the line survives even if a
    // caller only ever logs the failure's first sentence.
    write(`SMOKE: ${outcome.verdict.toUpperCase()} after ${ms}ms on ${attempts} attempt(s) — ${outcome.reason ?? "no reason recorded"}`);
    await running.stop();
    throw outcome.verdict === "timeout"
      ? new SmokeTimeoutError(ms, outcome.reason ?? "no reason recorded", outcome.progress)
      : new SmokeBrokenError(outcome.reason ?? "no reason recorded", outcome.progress);
  }

  write(`[assemble] smoke turn settled in ${ms}ms — host still running at ${running.baseUrl} (caller owns stop())`);
  return {
    slugs,
    host: running,
    smoke: { prompt: args.smokePrompt, ms, verdict: outcome.verdict, progress: outcome.progress, attempts },
  };
}
