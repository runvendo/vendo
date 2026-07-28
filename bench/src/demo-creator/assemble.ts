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

/**
 * Stage 4 — assemble. The gate that keeps a broken demo off demos.vendo.run:
 * the host must discover the new demo, compile it, boot, and survive ONE real
 * agent turn. The turn's CONTENT is not judged here (that is stage 5) — only
 * hard failure: the turn errored, or never settled.
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
  smoke: { prompt: string; ms: number };
}

/** A cold `pnpm install` + `next build` runs for minutes, and one smoke turn is
 * a real model round trip. Generous but bounded: a hang has to surface as a
 * failure, not eat the whole pipeline budget. */
const bootTimeoutMs = 180_000;
const smokeTimeoutMs = 180_000;

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
  try {
    await runStage("assemble:smoke", async () => await smokeTurn({
      baseUrl: running.baseUrl,
      slug: args.slug,
      prompt: args.smokePrompt,
      timeoutMs: smokeTimeoutMs,
    }));
  } catch (error) {
    // One dev server, no orphans: the host only survives a SUCCESSFUL smoke.
    await running.stop();
    throw error;
  }
  const ms = Date.now() - startedAt;
  write(`[assemble] smoke turn settled in ${ms}ms — host still running at ${running.baseUrl} (caller owns stop())`);
  return { slugs, host: running, smoke: { prompt: args.smokePrompt, ms } };
}
