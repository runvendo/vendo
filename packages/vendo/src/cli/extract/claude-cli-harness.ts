import { execFile } from "node:child_process";
import { composeGatewayFuel, type GatewayFuelOverlay } from "./gateway-fuel.js";
import type { ExtractionHarness, ExtractionRunInput } from "./harness.js";

/**
 * Fallback extraction harness: the `claude` CLI already on the dev's PATH,
 * driven headless (`-p`/print mode) with READ-ONLY code tools (Read/Glob/
 * Grep) over the host root. Credential = the dev's Claude Code login, or
 * their ANTHROPIC_API_KEY — same model as the SDK harness, just spawned as a
 * subprocess instead of imported as a module. This is the path that works
 * without shipping the Claude Agent SDK's ~245MB bundled native binary
 * (see claude-harness.ts) — most devs doing this already have Claude Code
 * installed for their own use.
 *
 * Isolation: `--setting-sources ""` (never inherit the dev's personal Claude
 * Code settings/hooks — same intent as claude-harness.ts's
 * `settingSources: []`), read-only tool allowlist, no shell/web/write surface.
 *
 * Gateway fuel: when neither an ANTHROPIC_API_KEY nor a Claude Code login is
 * available but VENDO_API_KEY is set, the rung runs on Vendo Cloud's model
 * gateway instead of degrading to unavailable (see gateway-fuel.ts). Own
 * credential always wins — this never overrides a working ANTHROPIC_API_KEY
 * or login.
 */

const ALLOWED_TOOLS = ["Read", "Glob", "Grep"];
const DISALLOWED_TOOLS = [
  "Bash", "Write", "Edit", "WebFetch", "WebSearch", "Task",
  "TodoWrite", "NotebookEdit", "KillShell", "BashOutput",
];
const PROBE_TIMEOUT_MS = 5_000;
// Extraction stages can run for minutes over a real codebase.
const RUN_TIMEOUT_MS = 10 * 60 * 1_000;
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

type Exec = (args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => Promise<ExecResult>;

function execClaude(args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      "claude",
      args,
      { cwd: options.cwd, env: options.env, timeout: RUN_TIMEOUT_MS, maxBuffer: MAX_BUFFER_BYTES },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
        resolve({ stdout, stderr, code });
      },
    );
  });
}

/** Cheap presence check: does `claude` resolve and run at all? */
function probeClaudeBinary(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("claude", ["--version"], { timeout: PROBE_TIMEOUT_MS }, (error) => resolve(error === null));
  });
}

/** `claude auth status` prints JSON with a `loggedIn` boolean. */
function probeClaudeLogin(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("claude", ["auth", "status"], { timeout: PROBE_TIMEOUT_MS }, (error, stdout) => {
      if (error !== null) return resolve(false);
      try {
        resolve((JSON.parse(stdout) as { loggedIn?: unknown }).loggedIn === true);
      } catch {
        resolve(false);
      }
    });
  });
}

export interface ClaudeCliHarnessOptions {
  /** Test seams. */
  probeBinary?: () => Promise<boolean>;
  probeLogin?: () => Promise<boolean>;
  exec?: Exec;
}

/** Gateway fuel only ever matters when VENDO_API_KEY is set — skip the
 *  (async) login probe entirely otherwise, so the own-credential path never
 *  pays for or is affected by this check. */
async function resolveGatewayFuelOverlay(
  env: Record<string, string | undefined>,
  probeLogin: () => Promise<boolean>,
): Promise<GatewayFuelOverlay | null> {
  const cloudKey = env["VENDO_API_KEY"];
  if (typeof cloudKey !== "string" || cloudKey.trim().length === 0) return null;
  const ownKey = env["ANTHROPIC_API_KEY"];
  const hasOwnKey = typeof ownKey === "string" && ownKey.trim().length > 0;
  const ownCredentialAvailable = hasOwnKey || (await probeLogin());
  return composeGatewayFuel({ env, ownCredentialAvailable });
}

export function claudeCliHarness(options: ClaudeCliHarnessOptions = {}): ExtractionHarness {
  const hasBinary = options.probeBinary ?? probeClaudeBinary;
  const probe = options.probeLogin ?? probeClaudeLogin;
  const exec = options.exec ?? execClaude;
  return {
    id: "claude-cli",
    async availability({ env }) {
      if (!(await hasBinary())) return null;
      const key = env["ANTHROPIC_API_KEY"];
      if (typeof key === "string" && key.trim().length > 0) return "your ANTHROPIC_API_KEY";
      if (await probe()) return "your Claude Code login";
      const cloudKey = env["VENDO_API_KEY"];
      if (typeof cloudKey === "string" && cloudKey.trim().length > 0) {
        return "your Vendo Cloud key (managed inference)";
      }
      return null;
    },
    async run(input: ExtractionRunInput): Promise<string> {
      const model = input.env["VENDO_EXTRACTION_MODEL"];
      const args = [
        "-p", input.instructions,
        "--allowedTools", ...ALLOWED_TOOLS,
        "--disallowedTools", ...DISALLOWED_TOOLS,
        "--setting-sources", "",
        ...(model === undefined ? [] : ["--model", model]),
      ];
      const overlay = await resolveGatewayFuelOverlay(input.env, probe);
      // Forward the caller's env so a key present only in the passed map
      // (not process.env) still authenticates the subprocess; gateway fuel
      // (if applicable) wins last.
      const result = await exec(args, { cwd: input.root, env: { ...process.env, ...input.env, ...overlay } });
      if (result.code !== 0) {
        throw new Error(`claude exited with code ${result.code}: ${result.stderr.trim() || "(no stderr)"}`);
      }
      return result.stdout;
    },
  };
}
