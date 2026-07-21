import { execFile } from "node:child_process";
import { composeGatewayFuel, hasOwnAnthropicEnvOverride, type GatewayFuelOverlay } from "./gateway-fuel.js";
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
 * Gateway fuel: when the dev has none of ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN,
 * CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_BASE_URL (the corporate-gateway/custom-
 * endpoint path), or a Claude Code login, but VENDO_API_KEY is set, the rung
 * runs on Vendo Cloud's model gateway instead of degrading to unavailable
 * (see gateway-fuel.ts). Own credential always wins — this never overrides a
 * working ANTHROPIC_API_KEY, login, or any of those env vars.
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

function isSet(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Gateway fuel only ever matters when VENDO_API_KEY is set — skip the
 *  (async) login probe entirely otherwise, so the own-credential path never
 *  pays for or is affected by this check. Env-based own-credential checks
 *  (ANTHROPIC_API_KEY, then OWN_CREDENTIAL_ENV_VARS) run before the probe
 *  too, since they're cheap and the probe is a subprocess spawn. */
async function resolveGatewayFuelOverlay(
  env: Record<string, string | undefined>,
  probeLogin: () => Promise<boolean>,
): Promise<GatewayFuelOverlay | null> {
  const cloudKey = env["VENDO_API_KEY"];
  if (!isSet(cloudKey)) return null;
  const ownCredentialAvailable = isSet(env["ANTHROPIC_API_KEY"])
    || hasOwnAnthropicEnvOverride(env)
    || (await probeLogin());
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
      // The child spawns with {...process.env, ...input.env} (see run()), so
      // credential checks and labels must see that SAME merged view: a
      // programmatic caller passing a partial env (say VENDO_API_KEY only)
      // while ambient process.env carries an ANTHROPIC_AUTH_TOKEN really
      // runs on that ambient token — labeling (or fueling) it as the Vendo
      // Cloud key would lie about, or worse clobber, the dev's own endpoint.
      const merged = { ...process.env, ...env };
      if (isSet(merged["ANTHROPIC_API_KEY"])) return "your ANTHROPIC_API_KEY";
      if (isSet(merged["ANTHROPIC_AUTH_TOKEN"])) return "your ANTHROPIC_AUTH_TOKEN";
      if (isSet(merged["CLAUDE_CODE_OAUTH_TOKEN"])) return "your CLAUDE_CODE_OAUTH_TOKEN";
      if (isSet(merged["ANTHROPIC_BASE_URL"])) return "your ANTHROPIC_BASE_URL";
      if (await probe()) return "your Claude Code login";
      if (isSet(merged["VENDO_API_KEY"])) return "your Vendo Cloud key (managed inference)";
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
      // Merge FIRST, then guard: the child is spawned with the caller's env
      // over process.env, so the own-credential check and gateway fuel must
      // evaluate that same merged env — guarding input.env alone would let
      // the overlay clobber an ambient (process.env) BYO endpoint the child
      // would otherwise have used. Gateway fuel (if applicable) wins last.
      const merged = { ...process.env, ...input.env };
      const overlay = await resolveGatewayFuelOverlay(merged, probe);
      const result = await exec(args, { cwd: input.root, env: { ...merged, ...overlay } });
      if (result.code !== 0) {
        throw new Error(`claude exited with code ${result.code}: ${result.stderr.trim() || "(no stderr)"}`);
      }
      return result.stdout;
    },
  };
}
