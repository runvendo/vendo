import { execFile, type ExecFileException } from "node:child_process";
import { composeGatewayFuel } from "./gateway-fuel.js";
import type { ExtractionHarness, ExtractionRunInput } from "./harness.js";

/**
 * Last-resort extraction harness: nothing Claude-shaped is installed on the
 * dev's machine (no Agent SDK, no `claude` binary, no `codex` binary), but
 * they do have a usable credential — so init fetches Claude Code itself via
 * `npm exec` rather than degrading straight to the honest skip. This is the
 * fourth and final rung of the ladder in extraction.ts.
 *
 * Cross-task contract (a parallel task builds `@vendoai/engine` to this exact
 * shape): `npm exec --yes @vendoai/engine@<PINNED_VERSION> -- run`, job JSON
 * `{ instructions, root }` on the child's stdin, credentials/base-url/headers
 * ride the child's process env (never the job JSON), stdout is EXACTLY the
 * agent's final text, stderr is progress/narration, exit 0 = success. The
 * version is pinned exact (never a range) so this rung's behavior can't
 * drift out from under init on a machine with no local install to pin
 * instead.
 *
 * Availability deliberately never touches npm or the network — it is called
 * eagerly for every rung on every `vendo init`, and a probe here would mean
 * every init pays an npm-registry round trip just to build the "AI polish?"
 * prompt. The ~250MB download surprise is disclosed instead via the
 * run-time notice below, right before the first real network access.
 *
 * Gateway fuel: mirrors claude-cli-harness.ts — when only VENDO_API_KEY is
 * set (no ANTHROPIC_API_KEY), the child runs against Vendo Cloud's model
 * gateway instead of degrading to unavailable (see gateway-fuel.ts). Own
 * credential always wins.
 */

export const ENGINE_PACKAGE_NAME = "@vendoai/engine";
export const ENGINE_PACKAGE_VERSION = "0.1.0";

// A one-time ~250MB package fetch plus the extraction stages themselves (which
// can already run for minutes over a real codebase on the other rungs) needs
// more headroom than the PATH-binary rungs' 10-minute budget.
const RUN_TIMEOUT_MS = 15 * 60 * 1_000;
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

// Extends the sibling harnesses' (args, options) Exec seam with `input` and
// `onStderrLine`: unlike `claude -p "<prompt>"` (prompt rides argv), this
// rung's child protocol reads the job off stdin and narrates progress over
// stderr line-by-line, so the seam needs both to be scriptable in tests.
type Exec = (
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; input: string; onStderrLine?: (line: string) => void },
) => Promise<ExecResult>;

/** Pure mapping from a completed `execFile` callback into an ExecResult —
 *  pulled out of the real spawn so the npm-not-found case (execFile's error
 *  has a string `code` like "ENOENT", not a process exit number) has direct
 *  unit coverage without actually spawning a missing binary (mirrors
 *  resolveCodexExecResult in codex-cli-harness.ts). */
export function resolveNpmExecResult(
  error: ExecFileException | null,
  stdout: string,
  stderr: string,
): ExecResult {
  if (error === null) return { stdout, stderr, code: 0 };
  if (typeof error.code === "number") return { stdout, stderr, code: error.code };
  // npm itself could not be launched — not installed, not on PATH, or the OS
  // refused to spawn it (error.code is a string like "ENOENT", not a process
  // exit number). execFile's own stdout/stderr are empty in this case, so the
  // actionable detail has to come from error.message; an offline registry, by
  // contrast, still lets npm launch and exit non-zero with its own
  // descriptive stderr, handled by the branch above and forwarded verbatim.
  return {
    stdout: "",
    stderr: `npm could not be launched (${error.message}) — is npm installed and on PATH?`,
    code: 1,
  };
}

function execNpmEngine(
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; input: string; onStderrLine?: (line: string) => void },
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = execFile(
      "npm",
      args,
      { cwd: options.cwd, env: options.env, timeout: RUN_TIMEOUT_MS, maxBuffer: MAX_BUFFER_BYTES },
      (error, stdout, stderr) => {
        resolve(resolveNpmExecResult(error, stdout, stderr));
      },
    );
    // stderr is progress/narration per the child protocol — forward it line
    // by line as it streams in, not just once the process exits.
    let buffer = "";
    child.stderr?.on("data", (chunk: Buffer | string) => {
      buffer += chunk.toString();
      let index = buffer.indexOf("\n");
      while (index !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.length > 0) options.onStderrLine?.(line);
        index = buffer.indexOf("\n");
      }
    });
    child.stdin?.write(options.input);
    child.stdin?.end();
  });
}

export interface NpxEngineHarnessOptions {
  /** Test seam. */
  exec?: Exec;
}

export function npxEngineHarness(options: NpxEngineHarnessOptions = {}): ExtractionHarness {
  const exec = options.exec ?? execNpmEngine;
  return {
    id: "npx-engine",
    async availability({ env }) {
      const key = env["ANTHROPIC_API_KEY"];
      if (typeof key === "string" && key.trim().length > 0) {
        return "your ANTHROPIC_API_KEY (via the Vendo engine, ~250MB one-time download)";
      }
      const cloudKey = env["VENDO_API_KEY"];
      if (typeof cloudKey === "string" && cloudKey.trim().length > 0) {
        return "your Vendo Cloud key (managed inference, via the Vendo engine, ~250MB one-time download)";
      }
      return null;
    },
    async run(input: ExtractionRunInput): Promise<string> {
      const ownKey = input.env["ANTHROPIC_API_KEY"];
      const hasOwnKey = typeof ownKey === "string" && ownKey.trim().length > 0;
      const overlay = composeGatewayFuel({ env: input.env, ownCredentialAvailable: hasOwnKey });

      // Visible-never-silent: the ~250MB fetch is a real surprise on a
      // machine with nothing installed, so it's disclosed up front, before
      // the child (and its network access) ever starts.
      input.onProgress?.(
        `Fetching ${ENGINE_PACKAGE_NAME}@${ENGINE_PACKAGE_VERSION} via npm exec (~250MB one-time download; `
        + "npm caches it locally, so later runs skip the download)…",
      );

      const job = JSON.stringify({ instructions: input.instructions, root: input.root });
      const args = ["exec", "--yes", `${ENGINE_PACKAGE_NAME}@${ENGINE_PACKAGE_VERSION}`, "--", "run"];
      // Forward the caller's env so a key present only in the passed map
      // (not process.env) still authenticates the child; gateway fuel (if
      // applicable) wins last — mirrors claude-cli-harness.ts.
      const result = await exec(args, {
        cwd: input.root,
        env: { ...process.env, ...input.env, ...overlay },
        input: job,
        onStderrLine: input.onProgress,
      });
      if (result.code !== 0) {
        throw new Error(
          `npm exec ${ENGINE_PACKAGE_NAME}@${ENGINE_PACKAGE_VERSION} exited with code ${result.code}: `
          + `${result.stderr.trim() || "(no stderr)"}`,
        );
      }
      return result.stdout;
    },
  };
}
