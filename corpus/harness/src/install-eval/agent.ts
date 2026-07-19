import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";

/**
 * Invoke a REAL headless coding agent — Claude Code (`claude -p …
 * --output-format stream-json`) — with only the north-star prompt, cwd'd
 * into the fixture. The full stream-json output is captured to a per-fixture
 * transcript file. Budgets: wall-clock (enforced by kill; the CLI has no
 * turn-cap flag in 2.1.x) and `--max-budget-usd` (enforced by the CLI).
 */

export interface RunInstallAgentOptions {
  prompt: string;
  cwd: string;
  transcriptPath: string;
  model: string;
  maxBudgetUsd: number;
  timeBudgetMs: number;
  claudeBin?: string;
  env?: NodeJS.ProcessEnv;
}

export interface InstallAgentResult {
  code: number | null;
  timedOut: boolean;
  command: string;
}

export function buildClaudeArgs(options: Pick<RunInstallAgentOptions, "prompt" | "model" | "maxBudgetUsd">): string[] {
  return [
    "-p", options.prompt,
    "--output-format", "stream-json",
    "--verbose",
    // The fixture is a disposable copy; the agent must run installs/inits
    // unattended. Never point this at a directory you care about.
    "--permission-mode", "bypassPermissions",
    "--no-session-persistence",
    // Exclude the machine's user-level CLAUDE.md/skills: the eval measures
    // the prompt + playbook, not a developer's personal setup. Fixtures ship
    // no project settings (prepareFixture strips .claude/, CLAUDE.md).
    "--setting-sources", "project",
    "--model", options.model,
    "--max-budget-usd", String(options.maxBudgetUsd),
  ];
}

/** Environment for the agent process: inherit, but drop VENDO_API_KEY so a
 * key on the eval machine cannot short-circuit the asked-before-account
 * metric (the agent must ask, not find a key lying around). */
export function agentEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...base };
  delete env["VENDO_API_KEY"];
  return env;
}

export async function runInstallAgent(options: RunInstallAgentOptions): Promise<InstallAgentResult> {
  const claudeBin = options.claudeBin ?? "claude";
  const args = buildClaudeArgs(options);
  await mkdir(path.dirname(options.transcriptPath), { recursive: true });
  const transcript = createWriteStream(options.transcriptPath);

  return new Promise<InstallAgentResult>((resolve, reject) => {
    const child = spawn(claudeBin, args, {
      cwd: options.cwd,
      env: agentEnv(options.env ?? process.env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => { child.kill("SIGKILL"); }, 10_000).unref();
    }, options.timeBudgetMs);

    child.stdout.pipe(transcript, { end: false });
    child.stderr.pipe(transcript, { end: false });
    child.on("error", (error) => {
      clearTimeout(timer);
      transcript.end();
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      transcript.end();
      resolve({ code, timedOut, command: `${claudeBin} ${args.map((arg) => (arg.includes(" ") ? JSON.stringify(arg) : arg)).join(" ")}` });
    });
  });
}
