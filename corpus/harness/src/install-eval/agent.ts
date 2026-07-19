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

/** Kill the agent's whole process group (SIGTERM, then SIGKILL escalation):
 * claude's grandchildren — an `npm install`, a dev server it booted — must
 * not outlive the budget, or an orphaned server on the fixture's fixed port
 * could answer the harness's later doctor probe and fake a green. */
function killProcessGroup(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  try {
    if (child.pid !== undefined) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    child.kill(signal);
  }
}

export async function runInstallAgent(options: RunInstallAgentOptions): Promise<InstallAgentResult> {
  const claudeBin = options.claudeBin ?? "claude";
  const args = buildClaudeArgs(options);
  await mkdir(path.dirname(options.transcriptPath), { recursive: true });
  const transcript = createWriteStream(options.transcriptPath);
  // stderr goes to its own log so the transcript stays pure JSONL.
  const stderrLog = createWriteStream(`${options.transcriptPath}.stderr.log`);

  return new Promise<InstallAgentResult>((resolve, reject) => {
    const child = spawn(claudeBin, args, {
      cwd: options.cwd,
      env: agentEnv(options.env ?? process.env),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessGroup(child, "SIGTERM");
      setTimeout(() => { killProcessGroup(child, "SIGKILL"); }, 10_000).unref();
    }, options.timeBudgetMs);
    const finish = (): void => {
      clearTimeout(timer);
      transcript.end();
      stderrLog.end();
    };

    child.stdout.pipe(transcript, { end: false });
    child.stderr.pipe(stderrLog, { end: false });
    child.on("error", (error) => {
      finish();
      reject(error);
    });
    child.on("close", (code) => {
      finish();
      // The agent is done; sweep any process-group stragglers regardless.
      killProcessGroup(child, "SIGKILL");
      resolve({ code, timedOut, command: `${claudeBin} ${args.map((arg) => (arg.includes(" ") ? JSON.stringify(arg) : arg)).join(" ")}` });
    });
  });
}
