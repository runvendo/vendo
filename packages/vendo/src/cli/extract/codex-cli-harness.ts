import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { extractionModelPin, type ExtractionHarness, type ExtractionRunInput } from "./harness.js";

/**
 * Fallback extraction harness: the `codex` CLI already on the dev's PATH,
 * driven headless (`codex exec`) with a READ-ONLY sandbox over the host
 * root. Credential = the dev's ChatGPT login (`codex login`), or their
 * OPENAI_API_KEY — this is the third rung of the ladder (after the Agent SDK
 * and claude-cli-harness.ts), for devs whose daily driver is Codex instead of
 * Claude Code and who don't want to install anything new.
 *
 * Isolation: `--sandbox read-only` (model-generated shell commands can only
 * read, never write or reach the network), `--skip-git-repo-check` (the host
 * root may not itself be a git repo — codex refuses to run outside one by
 * default, and extraction has no business caring), `--ignore-user-config`
 * (never load the dev's personal `~/.codex/config.toml` — same intent as
 * claude-cli-harness.ts's `--setting-sources ""`: their own MCP servers,
 * custom instructions, or notify hooks must not leak into extraction; auth
 * still resolves via CODEX_HOME regardless of this flag), `-C <root>` pins
 * the agent's working root explicitly.
 */

const PROBE_TIMEOUT_MS = 5_000;
// Extraction stages can run for minutes over a real codebase.
const RUN_TIMEOUT_MS = 10 * 60 * 1_000;
// codex's stdout under `exec` is throwaway tool-call narration — the actual
// payload comes back via --output-last-message and is read separately below.
// A narration stream over 10MB still trips execFile's maxBuffer and throws;
// that's a known, accepted failure mode (loud, not silent), not something
// worth raising just to tolerate noisier runs.
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

type Exec = (args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => Promise<ExecResult>;

/** Pure mapping from a completed `codex exec` subprocess (exit code/stderr)
 *  plus the outcome of reading its `--output-last-message` file into the
 *  harness's ExecResult. Pulled out of execCodex's callback and exported so
 *  the missing-file fallback — codex exited 0 but somehow wrote nothing —
 *  has direct unit coverage instead of living only behind the exec seam. */
export function resolveCodexExecResult(
  code: number,
  processStdout: string,
  stderr: string,
  finalMessage: string | undefined,
): ExecResult {
  if (code !== 0) return { stdout: processStdout, stderr, code };
  if (finalMessage !== undefined) return { stdout: finalMessage, stderr, code };
  // codex exited 0 but wrote no final-message file — there is nothing for
  // extraction.ts to parse; surface it as a failure through the same
  // code-path run() already uses for errors.
  return {
    stdout: "",
    stderr: "codex produced no final message (--output-last-message file missing)",
    code: 1,
  };
}

/** Insert `--output-last-message <file>` immediately before the free-text
 *  instructions positional (always the last element of a codex exec argv)
 *  rather than appending after it — a flag placed after a long, arbitrary
 *  free-text argument is fragile (positional/option disambiguation, and any
 *  prompt that happens to start with `-`). Exported and pure so the ordering
 *  is unit-tested without spawning a real process. */
export function insertOutputLastMessageFlag(args: string[], outputFile: string): string[] {
  return [...args.slice(0, -1), "--output-last-message", outputFile, ...args.slice(-1)];
}

/** `codex exec` has no print-mode equivalent to claude's `-p` stdout capture
 *  — the terminal stream is full of tool-call narration. `--output-last-
 *  message <file>` is codex's own mechanism for isolating just the agent's
 *  final text, so the real spawn writes it to a throwaway temp file and
 *  reads it back once the process exits cleanly. */
function execCodex(args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): Promise<ExecResult> {
  return (async () => {
    const outDir = await mkdtemp(join(tmpdir(), "vendo-codex-extract-"));
    const outputFile = join(outDir, "last-message.txt");
    try {
      return await new Promise<ExecResult>((resolve) => {
        execFile(
          "codex",
          insertOutputLastMessageFlag(args, outputFile),
          { cwd: options.cwd, env: options.env, timeout: RUN_TIMEOUT_MS, maxBuffer: MAX_BUFFER_BYTES },
          (error, stdout, stderr) => {
            const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
            if (code !== 0) {
              resolve(resolveCodexExecResult(code, stdout, stderr, undefined));
              return;
            }
            readFile(outputFile, "utf8").then(
              (finalMessage) => resolve(resolveCodexExecResult(code, stdout, stderr, finalMessage)),
              () => resolve(resolveCodexExecResult(code, stdout, stderr, undefined)),
            );
          },
        );
      });
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  })();
}

/** Cheap presence check: does `codex` resolve and run at all? */
function probeCodexBinary(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("codex", ["--version"], { timeout: PROBE_TIMEOUT_MS }, (error) => resolve(error === null));
  });
}

/** Codex persists login state to `$CODEX_HOME/auth.json` (default
 *  `~/.codex/auth.json`) — either a ChatGPT OAuth token pair (`auth_mode:
 *  "chatgpt"`) or an API key saved via `codex login --with-api-key`.
 *  `codex login status` has no machine-readable output, so this reads the
 *  file directly: a plain fs read that's cheap and trivially fake-able in
 *  tests without a real login. CODEX_HOME resolution mirrors run()'s own
 *  env merge (the caller's env wins over process.env) so availability's
 *  login check and the actual subprocess spawn never disagree about which
 *  codex home is in play. */
async function probeCodexLogin(env: Record<string, string | undefined>): Promise<boolean> {
  const codexHome = env["CODEX_HOME"] ?? process.env["CODEX_HOME"] ?? join(homedir(), ".codex");
  const authPath = join(codexHome, "auth.json");
  try {
    const parsed = JSON.parse(await readFile(authPath, "utf8")) as {
      OPENAI_API_KEY?: unknown;
      tokens?: { id_token?: unknown; access_token?: unknown };
    };
    if (typeof parsed.OPENAI_API_KEY === "string" && parsed.OPENAI_API_KEY.trim().length > 0) return true;
    if (typeof parsed.tokens?.id_token === "string" && parsed.tokens.id_token.trim().length > 0) return true;
    if (typeof parsed.tokens?.access_token === "string" && parsed.tokens.access_token.trim().length > 0) return true;
    return false;
  } catch {
    return false;
  }
}

export interface CodexCliHarnessOptions {
  /** Test seams. */
  probeBinary?: () => Promise<boolean>;
  probeLogin?: (env: Record<string, string | undefined>) => Promise<boolean>;
  exec?: Exec;
}

export function codexCliHarness(options: CodexCliHarnessOptions = {}): ExtractionHarness {
  const hasBinary = options.probeBinary ?? probeCodexBinary;
  const probe = options.probeLogin ?? probeCodexLogin;
  const exec = options.exec ?? execCodex;
  return {
    id: "codex-cli",
    async availability({ env }) {
      if (!(await hasBinary())) return null;
      const key = env["OPENAI_API_KEY"];
      if (typeof key === "string" && key.trim().length > 0) return "your OPENAI_API_KEY";
      if (await probe(env)) return "your ChatGPT login";
      return null;
    },
    async run(input: ExtractionRunInput): Promise<string> {
      const model = extractionModelPin(input.env);
      const args = [
        "exec",
        "--sandbox", "read-only",
        "--skip-git-repo-check",
        "--ignore-user-config",
        "-C", input.root,
        ...(model === undefined ? [] : ["--model", model]),
        input.instructions,
      ];
      // Forward the caller's env so a key present only in the passed map
      // (not process.env) still authenticates the subprocess.
      const result = await exec(args, { cwd: input.root, env: { ...process.env, ...input.env } });
      if (result.code !== 0) {
        throw new Error(`codex exited with code ${result.code}: ${result.stderr.trim() || "(no stderr)"}`);
      }
      return result.stdout;
    },
  };
}
