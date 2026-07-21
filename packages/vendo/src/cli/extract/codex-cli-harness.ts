import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtractionHarness, ExtractionRunInput } from "./harness.js";

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
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

type Exec = (args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => Promise<ExecResult>;

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
          [...args, "--output-last-message", outputFile],
          { cwd: options.cwd, env: options.env, timeout: RUN_TIMEOUT_MS, maxBuffer: MAX_BUFFER_BYTES },
          (error, stdout, stderr) => {
            const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
            if (code !== 0) {
              resolve({ stdout, stderr, code });
              return;
            }
            readFile(outputFile, "utf8").then(
              (finalMessage) => resolve({ stdout: finalMessage, stderr, code }),
              // codex exited 0 but wrote no final-message file — there is
              // nothing for extraction.ts to parse; surface it as a failure
              // through the same code-path run() already uses for errors.
              () => resolve({
                stdout: "",
                stderr: "codex produced no final message (--output-last-message file missing)",
                code: 1,
              }),
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
 *  tests without a real login. */
async function probeCodexLogin(): Promise<boolean> {
  const authPath = join(process.env["CODEX_HOME"] ?? join(homedir(), ".codex"), "auth.json");
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
  probeLogin?: () => Promise<boolean>;
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
      if (await probe()) return "your ChatGPT login";
      return null;
    },
    async run(input: ExtractionRunInput): Promise<string> {
      const model = input.env["VENDO_EXTRACTION_MODEL"];
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
