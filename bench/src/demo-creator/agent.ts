import { spawn } from "node:child_process";
import path from "node:path";

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
  /** What the CLI's permission layer refused, e.g. `Write /repo/host/...`. An
   * agent that tried to leave its folder is a fact the operator must see, not
   * one buried in a transcript — and an empty list on a run that DID write
   * outside the folder is how finding 1 was proved. */
  permissionDenials: string[];
}

/**
 * The filesystem box an agent runs in, enforced by the claude CLI's own
 * permission layer rather than by prompt wording.
 *
 * `writeRoot` is the agent's cwd and the only place it may create or edit a
 * file; `readRoot` is the checkout it may READ (the build prompts send every
 * agent to `demos/_example` first, which is outside its own folder).
 */
export interface AgentSandbox {
  /** Absolute path — the demo folder. */
  writeRoot: string;
  /** Absolute path — the vendo-demos checkout. */
  readRoot: string;
  /** writeRoot-relative paths that stay READ-ONLY even inside it: the brand
   * evidence the pipeline wrote (theme.json, BRIEF.md, brand/, RESEARCH/). */
  fenced?: string[];
  /** writeRoot-relative paths this agent may write. Given, Write/Edit are scoped
   * to exactly these instead of the whole demo folder, so the ownership split
   * between the parallel build agents is enforced by the harness rather than by
   * the prompt asking nicely. Omitted (demo:fix's single agent) = the folder. */
  ownedRoots?: string[];
}

export interface RunAgentOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Read-only run (a planning pass): no Write/Edit. */
  readOnly?: boolean;
  /** Aborting kills the agent subprocess (the pipeline's wall-clock cap). */
  signal?: AbortSignal;
  /** REQUIRED: what this agent may read and write. */
  sandbox: AgentSandbox;
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

/** A settings path rule for one tool. A leading `//` is the CLI's
 * absolute-path form (a single `/` anchors at the settings source instead). */
function rule(tool: string, absolutePath: string): string {
  return `${tool}(/${absolutePath})`;
}

/** The brand evidence a generation agent must never rewrite. The contract has
 * always said so; until now only the prompt did. */
export const fencedDemoPaths = ["theme.json", "BRIEF.md", "brand", "RESEARCH"];

/**
 * The `--settings` payload that boxes an agent into its demo folder.
 *
 * Written as a JSON STRING argument rather than a file so there is no temp file
 * to leak, land in the demos repo, or go stale between runs.
 *
 * Rule shapes: `deny` outranks `allow` outranks the mode, so the shared paths
 * (the host, the brand evidence) are spelled out as denials instead of being
 * left to "outside the working directory". Note what is deliberately NOT here: a
 * blanket `Write(//<repo>/demos/**)` deny would also deny the one folder the
 * agent exists to write.
 */
export function buildSandboxSettings(sandbox: AgentSandbox): string {
  const deny: string[] = [];
  for (const tool of ["Write", "Edit", "NotebookEdit"]) {
    // The host is shared by every live demo: caps guard, watermark, auth wall,
    // Vendo kit. Denied by absolute path, so it holds wherever cwd is.
    deny.push(rule(tool, `${path.join(sandbox.readRoot, "host")}/**`));
    for (const fenced of sandbox.fenced ?? fencedDemoPaths) {
      const target = path.join(sandbox.writeRoot, fenced);
      deny.push(rule(tool, target), rule(tool, `${target}/**`));
    }
  }
  const allow: string[] = [];
  for (const tool of ["Read", "Glob", "Grep"]) {
    // Reading the checkout is the job (BRIEF.md, the reference screenshot,
    // demos/_example); only writing is fenced.
    allow.push(rule(tool, `${sandbox.readRoot}/**`));
  }
  return JSON.stringify({ permissions: { allow, deny } });
}

/**
 * The writable-tool rules. The SCOPE rides `--allowedTools` itself, which is
 * what actually denies: probed against claude 2.1.220, an unscoped `Write` in
 * `--allowedTools` allows Write at ANY path (the escape landed under
 * `acceptEdits` AND under `manual` with allow rules in `--settings`), while
 * `Write(//<dir>/**)` refuses a write outside <dir> and records it in
 * `permission_denials`.
 */
function writableToolRules(sandbox: AgentSandbox): string[] {
  const roots = sandbox.ownedRoots ?? [];
  // Both forms per root: a root is `server/` for one agent and `openapi.json` for
  // another, and neither exists yet when these rules are written, so there is
  // nothing to stat. The exact path covers the file, the subtree covers the
  // directory.
  const targets = roots.length === 0
    ? [`${sandbox.writeRoot}/**`]
    : roots.flatMap((root) => {
      const target = path.join(sandbox.writeRoot, root);
      return [target, `${target}/**`];
    });
  return ["Write", "Edit"].flatMap((tool) => targets.map((target) => rule(tool, target)));
}

export function buildClaudeArgs(
  job: Pick<AgentJob, "prompt" | "maxBudgetUsd" | "model">,
  options: { readOnly?: boolean; sandbox: AgentSandbox },
): string[] {
  const tools = ["Read", "Glob", "Grep", ...(options.readOnly === true ? [] : writableToolRules(options.sandbox))];
  return [
    "-p", job.prompt,
    "--output-format", "json",
    // NOT bypassPermissions: under it the CLI evaluates no rule at all, and a
    // live probe wrote outside the demo folder with `permission_denials: []` —
    // the three escapes the checker tried were stopped by the model choosing to
    // refuse, which is not a boundary. `manual` keeps the permission layer on;
    // in headless there is nobody to prompt, so anything unallowed is denied.
    "--permission-mode", "manual",
    // Deny rules for the paths every demo shares (the host) and the brand
    // evidence inside this folder. Proved to block, and they hold wherever cwd
    // is; `--setting-sources ""` does not discard them.
    "--settings", buildSandboxSettings(options.sandbox),
    "--allowedTools", ...tools,
    "--disallowedTools", "Bash", "WebFetch", "WebSearch", "Task", "TodoWrite", "NotebookEdit", "KillShell", "BashOutput",
    // READ access to the checkout: every build prompt sends the agent to
    // demos/_example first, and that is one directory above its own.
    "--add-dir", options.sandbox.readRoot,
    // Nothing from the operator's machine: no user CLAUDE.md, no project hooks,
    // no plugin that could re-widen what this agent may touch.
    "--setting-sources", "",
    "--model", job.model,
    "--max-budget-usd", String(job.maxBudgetUsd),
  ];
}

/** Extracts {result, total_cost_usd, is_error} from `claude --output-format
 * json` (shape live-verified against claude CLI 2.1.x). */
export function parseAgentOutput(stdout: string): { output: string; costUsd?: number; isError: boolean; permissionDenials: string[] } {
  try {
    const parsed = JSON.parse(stdout) as {
      result?: unknown;
      total_cost_usd?: unknown;
      is_error?: unknown;
      permission_denials?: unknown;
    };
    const denials = Array.isArray(parsed.permission_denials) ? parsed.permission_denials : [];
    return {
      output: typeof parsed.result === "string" ? parsed.result : stdout,
      isError: parsed.is_error === true,
      permissionDenials: denials.map((denial) => {
        const entry = denial as { tool_name?: unknown; tool_input?: { file_path?: unknown; path?: unknown } };
        const target = entry.tool_input?.file_path ?? entry.tool_input?.path;
        return `${String(entry.tool_name ?? "tool")}${typeof target === "string" ? ` ${target}` : ""}`;
      }),
      ...(typeof parsed.total_cost_usd === "number" ? { costUsd: parsed.total_cost_usd } : {}),
    };
  } catch {
    return { output: stdout, isError: false, permissionDenials: [] };
  }
}

/** A budget-exceeded or otherwise errored run can still exit 0, so `is_error`
 * in the JSON payload — not the process code — decides whether the agent
 * failed. Trusting the exit code alone ships a demo whose generation agent
 * silently did nothing. */
export function effectiveExitCode(exitCode: number | null, isError: boolean): number {
  const code = exitCode ?? 1;
  if (code !== 0) return code;
  return isError ? 1 : 0;
}

export const defaultRunAgent: RunAgentFn = (job, options) =>
  new Promise((resolve, reject) => {
    const child = spawn("claude", buildClaudeArgs(job, { readOnly: options.readOnly ?? false, sandbox: options.sandbox }), {
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
      resolve({
        name: job.name,
        code: effectiveExitCode(code, parsed.isError),
        output: parsed.output === "" ? stderr : parsed.output,
        ...(parsed.costUsd === undefined ? {} : { costUsd: parsed.costUsd }),
        timedOut,
        permissionDenials: parsed.permissionDenials,
      });
    });
  });
