import { spawn } from "node:child_process";

/**
 * The headless `claude` CLI spawn used by every generation agent in the
 * pipeline (the three build agents and `demo:fix`). Same PATH-CLI harness
 * pattern as packages/vendo's claude-cli-harness and the corpus install-eval
 * agent: no SDK, no session state — one prompt in, one JSON result out.
 */

export interface AgentJob {
  name: string;
  prompt: string;
  /** Demo-folder-relative roots this agent may create/edit — the ONLY writable
   * area. Disjointness across concurrent jobs is asserted before anything runs. */
  ownedRoots: string[];
  maxBudgetUsd: number;
  timeoutMs: number;
  /** claude model flag. */
  model: string;
}

export interface AgentRunResult {
  name: string;
  code: number;
  /** Final text (the `result` field of --output-format json, or raw stdout). */
  output: string;
  costUsd?: number;
  timedOut: boolean;
}

export interface RunAgentOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Read-only run (a planning pass): no Write/Edit. */
  readOnly?: boolean;
  /** Aborting kills the agent subprocess (the pipeline's wall-clock cap). */
  signal?: AbortSignal;
}

export type RunAgentFn = (job: Pick<AgentJob, "name" | "prompt" | "maxBudgetUsd" | "timeoutMs" | "model">, options: RunAgentOptions) => Promise<AgentRunResult>;

/** Any overlap between two agents' writable roots = the split is broken;
 * refuse to run rather than let parallel edits race. */
export function assertDisjointOwnership(jobs: readonly AgentJob[]): void {
  for (const a of jobs) {
    for (const b of jobs) {
      if (a === b) continue;
      for (const rootA of a.ownedRoots) {
        for (const rootB of b.ownedRoots) {
          if (rootA === rootB || rootB.startsWith(`${rootA}/`)) {
            throw new Error(`Agent file split overlaps: "${a.name}" owns ${rootA}, "${b.name}" owns ${rootB} — redesign the split`);
          }
        }
      }
    }
  }
}

export function buildClaudeArgs(job: Pick<AgentJob, "prompt" | "maxBudgetUsd" | "model">, options: { readOnly?: boolean } = {}): string[] {
  const tools = options.readOnly === true ? ["Read", "Glob", "Grep"] : ["Read", "Glob", "Grep", "Write", "Edit"];
  return [
    "-p", job.prompt,
    "--output-format", "json",
    // The demo folder is a generated artifact; agents must write without
    // prompting. Tool allowlist still excludes Bash/Web/Task everywhere.
    "--permission-mode", "bypassPermissions",
    "--allowedTools", ...tools,
    "--disallowedTools", "Bash", "WebFetch", "WebSearch", "Task", "TodoWrite", "NotebookEdit", "KillShell", "BashOutput",
    "--setting-sources", "",
    "--model", job.model,
    "--max-budget-usd", String(job.maxBudgetUsd),
  ];
}

/** Extracts {result, total_cost_usd, is_error} from `claude --output-format
 * json` (shape live-verified against claude CLI 2.1.x). */
export function parseAgentOutput(stdout: string): { output: string; costUsd?: number; isError: boolean } {
  try {
    const parsed = JSON.parse(stdout) as { result?: unknown; total_cost_usd?: unknown; is_error?: unknown };
    return {
      output: typeof parsed.result === "string" ? parsed.result : stdout,
      isError: parsed.is_error === true,
      ...(typeof parsed.total_cost_usd === "number" ? { costUsd: parsed.total_cost_usd } : {}),
    };
  } catch {
    return { output: stdout, isError: false };
  }
}

export const defaultRunAgent: RunAgentFn = (job, options) =>
  new Promise((resolve, reject) => {
    const child = spawn("claude", buildClaudeArgs(job, { readOnly: options.readOnly ?? false }), {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, job.timeoutMs);
    const onAbort = (): void => { child.kill("SIGKILL"); };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      reject(new Error(`Could not spawn the claude CLI for agent "${job.name}": ${error.message} — is claude on PATH?`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      const parsed = parseAgentOutput(stdout);
      // A budget-exceeded/errored run can still exit 0 — is_error is truth.
      const effectiveCode = (code ?? 1) !== 0 ? (code ?? 1) : parsed.isError ? 1 : 0;
      resolve({
        name: job.name,
        code: effectiveCode,
        output: parsed.output === "" ? stderr : parsed.output,
        ...(parsed.costUsd === undefined ? {} : { costUsd: parsed.costUsd }),
        timedOut,
      });
    });
  });
