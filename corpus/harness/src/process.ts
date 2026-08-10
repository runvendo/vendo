import { spawn } from "node:child_process";

export interface CommandResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** Both streams in arrival order — what a human reading the log wants. */
  combined: string;
}

export interface RunCommandOptions {
  /** Omit to run `command` through a shell; pass args to spawn it directly. */
  args?: readonly string[];
  cwd: string;
  /** Omitted means inherit the harness's own environment. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Spawn a command, collect both streams, and resolve however it exits — a
 * non-zero code is a result, not an error. Rejects only when the process could
 * not be spawned at all.
 */
export function runCommand(command: string, options: RunCommandOptions): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = options.args
      ? spawn(command, options.args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] })
      : spawn(command, { cwd: options.cwd, env: options.env, shell: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let combined = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      combined += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      combined += chunk;
    });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr, combined }));
  });
}

/**
 * A pinned checkout's `engines.node` is about the day it was pinned, not about
 * Vendo — with the repo's own `engine-strict=true` it fails the whole run on
 * whatever Node the corpus host happens to have (rallly: engines.node 24 vs the
 * sweep box's Node 26). The two pnpm generations read different env vars for it:
 * pnpm ≤10 takes npm's (`npm_config_*`, via @pnpm/npm-conf), pnpm 11 only its
 * own `PNPM_CONFIG_*`, and each ignores the other — so both spellings are set.
 */
export const ENGINE_STRICT_OFF_ENV: NodeJS.ProcessEnv = {
  npm_config_engine_strict: "false",
  PNPM_CONFIG_ENGINE_STRICT: "false",
};

/**
 * Host repos are third-party checkouts pinned to a sha: relax the guards that
 * would fail their install for reasons that have nothing to do with Vendo.
 */
export function corpusHostCommandEnv(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...env,
    ...ENGINE_STRICT_OFF_ENV,
    PNPM_CONFIG_MINIMUM_RELEASE_AGE: "0",
    PNPM_CONFIG_DANGEROUSLY_ALLOW_ALL_BUILDS: "true",
    YARN_ENABLE_IMMUTABLE_INSTALLS: "false",
  };
}

/** The shell runner every host-facing command in the harness goes through. */
export function runHostCommand(command: string, options: { cwd: string; env?: NodeJS.ProcessEnv }): Promise<CommandResult> {
  return runCommand(command, { cwd: options.cwd, env: corpusHostCommandEnv(options.env) });
}
