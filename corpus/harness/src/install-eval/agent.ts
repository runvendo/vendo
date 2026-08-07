import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { detectsKeyQuestion } from "./score.js";
import { finalAssistantText, parseTranscript, totalCostUsd } from "./transcript.js";

/**
 * Invoke a REAL headless coding agent — Claude Code (`claude -p …
 * --output-format stream-json`) — with only the north-star prompt, cwd'd
 * into the fixture. The full stream-json output is captured to a per-fixture
 * transcript file. Budgets: wall-clock (enforced by kill; the CLI has no
 * turn-cap flag in 2.1.x) and `--max-budget-usd` (enforced by the CLI).
 *
 * SCRIPTED-HUMAN SEAM (#480): the playbook mandates the agent STOP and ask
 * Cloud-vs-BYO before touching keys, so a single-shot run always ends at that
 * gate and doctor/star-ask scoring is unreachable. When the first invocation
 * ends on that question (`detectsKeyQuestion`), the runner replies ONCE via
 * `claude -p --resume <session-id> …` with a fixed bring-your-own answer and
 * appends the continuation to the same transcript. Exactly one reply per run:
 * a second ask (or the star ask, which is the run's terminal step) ends the
 * run as before. Sessions therefore persist (`--session-id` replaces the old
 * `--no-session-persistence`); the CLI has no session-delete flag in 2.1.x,
 * so each run leaves one small JSONL session under ~/.claude/projects/ keyed
 * by the harness-minted UUID below.
 */

export const SCRIPTED_HUMAN_ANSWER =
  "Bring-your-own — ANTHROPIC_API_KEY is already set in .env.local. Do not create any account. "
  + "Continue to a green vendo doctor --json, then finish per the original instructions.";

export interface RunInstallAgentOptions {
  prompt: string;
  cwd: string;
  transcriptPath: string;
  model: string;
  maxBudgetUsd: number;
  timeBudgetMs: number;
  claudeBin?: string;
  env?: NodeJS.ProcessEnv;
  /** Session UUID for the run (minted when omitted) — pinned so the scripted
   * continuation can `--resume` it and tests stay deterministic. */
  sessionId?: string;
}

export interface InstallAgentResult {
  code: number | null;
  timedOut: boolean;
  command: string;
  /** How many scripted-human answers were sent (hard cap: 1 per run). */
  scriptedReplies: number;
}

export interface ClaudeArgsOptions extends Pick<RunInstallAgentOptions, "prompt" | "model" | "maxBudgetUsd"> {
  /** `resume: false` mints the session; `resume: true` is the scripted-human
   * continuation of the same session. */
  session: { id: string; resume: boolean };
}

export function buildClaudeArgs(options: ClaudeArgsOptions): string[] {
  return [
    "-p", options.prompt,
    "--output-format", "stream-json",
    "--verbose",
    // The fixture is a disposable copy; the agent must run installs/inits
    // unattended. Never point this at a directory you care about.
    "--permission-mode", "bypassPermissions",
    ...(options.session.resume ? ["--resume", options.session.id] : ["--session-id", options.session.id]),
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
  // The agent exercises the REAL end-user flow — `npx vendo init` runs with
  // telemetry live on purpose, so the eval also certifies the telemetry path.
  // VENDO_INTERNAL tags those events `internal: true` (the analytics project
  // filters on it) instead of dropping them. Deliberately not
  // VENDO_TELEMETRY_DISABLED: dropping would blind the cert to telemetry
  // regressions while these runs polluted launch metrics untagged.
  env["VENDO_INTERNAL"] = "1";
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

interface InvokeClaudeOnceOptions {
  claudeBin: string;
  args: string[];
  cwd: string;
  transcriptPath: string;
  timeBudgetMs: number;
  env: NodeJS.ProcessEnv;
  /** The scripted-human continuation appends to the first turn's transcript
   * so scoring reads one file across both invocations. */
  append: boolean;
}

interface InvokeClaudeOnceResult {
  code: number | null;
  timedOut: boolean;
  command: string;
}

async function invokeClaudeOnce(options: InvokeClaudeOnceOptions): Promise<InvokeClaudeOnceResult> {
  await mkdir(path.dirname(options.transcriptPath), { recursive: true });
  const flags = options.append ? "a" : "w";
  const transcript = createWriteStream(options.transcriptPath, { flags });
  // stderr goes to its own log so the transcript stays pure JSONL.
  const stderrLog = createWriteStream(`${options.transcriptPath}.stderr.log`, { flags });

  return new Promise<InvokeClaudeOnceResult>((resolve, reject) => {
    const child = spawn(options.claudeBin, options.args, {
      cwd: options.cwd,
      env: options.env,
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
      resolve({ code, timedOut, command: `${options.claudeBin} ${options.args.map((arg) => (arg.includes(" ") ? JSON.stringify(arg) : arg)).join(" ")}` });
    });
  });
}

export async function runInstallAgent(options: RunInstallAgentOptions): Promise<InstallAgentResult> {
  const claudeBin = options.claudeBin ?? "claude";
  const sessionId = options.sessionId ?? randomUUID();
  const env = agentEnv(options.env ?? process.env);
  const startedAt = Date.now();

  const first = await invokeClaudeOnce({
    claudeBin,
    args: buildClaudeArgs({ ...options, session: { id: sessionId, resume: false } }),
    cwd: options.cwd,
    transcriptPath: options.transcriptPath,
    timeBudgetMs: options.timeBudgetMs,
    env,
    append: false,
  });
  const singleShot: InstallAgentResult = { ...first, scriptedReplies: 0 };
  // Only a clean first turn can be continued: a timed-out or errored run has
  // no session to resume into (and is already a red result).
  if (first.timedOut || first.code !== 0) return singleShot;

  const events = parseTranscript(await readFile(options.transcriptPath, "utf8"));
  const finalText = finalAssistantText(events);
  if (finalText === null || !detectsKeyQuestion(finalText)) return singleShot;

  // Both budgets cover the WHOLE run: the continuation only gets what the
  // first invocation left over (cost rounded to cents for the CLI flag).
  const timeLeftMs = options.timeBudgetMs - (Date.now() - startedAt);
  const budgetLeftUsd = Math.round((options.maxBudgetUsd - (totalCostUsd(events) ?? 0)) * 100) / 100;
  if (timeLeftMs <= 0 || budgetLeftUsd <= 0) return singleShot;

  const second = await invokeClaudeOnce({
    claudeBin,
    args: buildClaudeArgs({
      prompt: SCRIPTED_HUMAN_ANSWER,
      model: options.model,
      maxBudgetUsd: budgetLeftUsd,
      session: { id: sessionId, resume: true },
    }),
    cwd: options.cwd,
    transcriptPath: options.transcriptPath,
    timeBudgetMs: timeLeftMs,
    env,
    append: true,
  });
  return {
    code: second.code,
    timedOut: second.timedOut,
    command: `${first.command} && ${second.command}`,
    scriptedReplies: 1,
  };
}
