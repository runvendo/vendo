import { execFile, type ExecFileException } from "node:child_process";
import { composeGatewayFuel, hasOwnAnthropicEnvOverride } from "./gateway-fuel.js";
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
 * Gateway fuel: mirrors claude-cli-harness.ts — when the dev has none of
 * ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN, or
 * ANTHROPIC_BASE_URL (the corporate-gateway/custom-endpoint path) but
 * VENDO_API_KEY is set, the child runs against Vendo Cloud's model gateway
 * instead of degrading to unavailable (see gateway-fuel.ts). Own credential
 * always wins — availability() must label these honestly (not as "Vendo
 * Cloud key") since composeGatewayFuel itself refuses to overlay onto any of
 * them; a wrong label here would make the consent prompt lie about what
 * run() actually does.
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
 *  pulled out of the real spawn so the four ways `error` shows up (a normal
 *  nonzero exit, a real spawn-layer failure, the RUN_TIMEOUT_MS kill, or the
 *  MAX_BUFFER_BYTES kill) each get direct unit coverage without actually
 *  spawning anything (mirrors resolveCodexExecResult in
 *  codex-cli-harness.ts). The four are easy to conflate — all leave
 *  `error.code` non-numeric — but they need different messages: a killed
 *  15-minute extraction run is not npm being uninstalled, and a >10MB
 *  narration stream is not a timeout. */
export function resolveNpmExecResult(
  error: ExecFileException | null,
  stdout: string,
  stderr: string,
): ExecResult {
  if (error === null) return { stdout, stderr, code: 0 };
  if (typeof error.code === "number") return { stdout, stderr, code: error.code };
  if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    // execFile's `maxBuffer` kill also sets error.killed, so this must be
    // checked BEFORE the killed branch below — a >10MB narration stream is
    // not the 15-minute timeout, and labeling it as one would send the dev
    // chasing a slowness that isn't there.
    const megabytes = Math.round(MAX_BUFFER_BYTES / (1024 * 1024));
    return {
      stdout: "",
      stderr: `npm exec output exceeded the ${megabytes}MB buffer — the engine's narration stream was `
        + "larger than expected, so the child was killed before finishing",
      code: 1,
    };
  }
  if (error.killed === true) {
    // execFile's `timeout` option SIGTERMs a still-running child — a
    // legitimate long extraction run, not a broken npm install. This must be
    // checked before the spawn-failure branch below: a kill leaves
    // error.code null (not a string), so it would otherwise fall into "npm
    // could not be launched" and mislabel the dev's own long-running job as
    // a missing npm.
    const minutes = Math.round(RUN_TIMEOUT_MS / 60_000);
    return {
      stdout: "",
      stderr: `npm exec was killed for exceeding the ${minutes}-minute timeout`
        + (error.signal !== undefined ? ` (${error.signal})` : ""),
      code: 1,
    };
  }
  if (typeof error.code === "string") {
    // A real spawn-layer failure (error.code is an errno string like
    // "ENOENT" or "EACCES", set when the OS never launched the child at
    // all) — npm itself could not be launched: not installed, not on PATH,
    // or not executable. execFile's own stdout/stderr are empty in this
    // case, so the actionable detail has to come from error.message.
    return {
      stdout: "",
      stderr: `npm could not be launched (${error.message}) — is npm installed and on PATH?`,
      code: 1,
    };
  }
  // Any other shape (no numeric exit code, not killed, no string spawn
  // code) — don't fabricate a diagnosis; forward whatever npm itself wrote.
  // An offline registry lands here: npm still launches and exits non-zero
  // with its own descriptive stderr (e.g. "npm error code ENOTFOUND"),
  // which run()'s nonzero-exit handling forwards to the dev verbatim.
  return { stdout, stderr, code: 1 };
}

/** Line-buffered splitter for a live-streaming descriptor, extracted out of
 *  execNpmEngine so it's directly unit-testable without a real child
 *  process: a line split across two `data` chunks, and — the bug this
 *  fixes — a trailing line with no final newline, which `flush()` still
 *  delivers instead of silently dropping the child's last progress line
 *  when the stream ends without one. */
export function createLineSplitter(onLine: (line: string) => void): { push(chunk: string): void; flush(): void } {
  let buffer = "";
  return {
    push(chunk: string) {
      buffer += chunk;
      let index = buffer.indexOf("\n");
      while (index !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.length > 0) onLine(line);
        index = buffer.indexOf("\n");
      }
    },
    flush() {
      if (buffer.length > 0) onLine(buffer);
      buffer = "";
    },
  };
}

function execNpmEngine(
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; input: string; onStderrLine?: (line: string) => void },
): Promise<ExecResult> {
  return new Promise((resolve) => {
    // stderr is progress/narration per the child protocol — forward it line
    // by line as it streams in, not just once the process exits; flush()
    // in the callback below delivers any trailing partial line too.
    const splitter = createLineSplitter((line) => options.onStderrLine?.(line));
    const child = execFile(
      "npm",
      args,
      { cwd: options.cwd, env: options.env, timeout: RUN_TIMEOUT_MS, maxBuffer: MAX_BUFFER_BYTES },
      (error, stdout, stderr) => {
        splitter.flush();
        resolve(resolveNpmExecResult(error, stdout, stderr));
      },
    );
    child.stderr?.on("data", (chunk: Buffer | string) => splitter.push(chunk.toString()));
    // If the child exits (or is killed by the timeout) before the stdin
    // write drains, Node emits an unhandled EPIPE 'error' on this stream —
    // with no listener, that's an uncaughtException that aborts all of
    // `vendo init`, bypassing extraction.ts's graceful per-rung degradation.
    // The real outcome always arrives via the execFile callback's exit code
    // + stderr above, so this handler is intentionally a no-op.
    child.stdin?.on("error", () => {});
    child.stdin?.write(options.input);
    child.stdin?.end();
  });
}

function isSet(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

// Every label this rung can return carries the download disclosure, since
// (unlike the PATH-binary rungs) a fetch always happens here.
const DOWNLOAD_NOTE = "via the Vendo engine, ~250MB one-time download";
const DOWNLOAD_SUFFIX = ` (${DOWNLOAD_NOTE})`;

export interface NpxEngineHarnessOptions {
  /** Test seam. */
  exec?: Exec;
}

export function npxEngineHarness(options: NpxEngineHarnessOptions = {}): ExtractionHarness {
  const exec = options.exec ?? execNpmEngine;
  return {
    id: "npx-engine",
    async availability({ env }) {
      // The child spawns with {...process.env, ...input.env} (see run()), so
      // the label must be judged against that SAME merged view — an ambient
      // (process.env) own credential is the one the child would actually
      // use, even when the caller's partial env carries only VENDO_API_KEY.
      const merged = { ...process.env, ...env };
      if (isSet(merged["ANTHROPIC_API_KEY"])) return `your ANTHROPIC_API_KEY${DOWNLOAD_SUFFIX}`;
      // The corporate-gateway/custom-endpoint env vars are an own credential
      // too (see gateway-fuel.ts's INVARIANT) — composeGatewayFuel refuses to
      // overlay onto them regardless of what run() passes, so labeling this
      // rung "your Vendo Cloud key" here would be a lie about what actually
      // runs. Per-var labels (same priority order as claude-cli-harness.ts)
      // so the consent line names the credential that's really in play.
      if (hasOwnAnthropicEnvOverride(merged)) {
        if (isSet(merged["ANTHROPIC_AUTH_TOKEN"])) return `your ANTHROPIC_AUTH_TOKEN${DOWNLOAD_SUFFIX}`;
        if (isSet(merged["CLAUDE_CODE_OAUTH_TOKEN"])) return `your CLAUDE_CODE_OAUTH_TOKEN${DOWNLOAD_SUFFIX}`;
        return `your ANTHROPIC_BASE_URL${DOWNLOAD_SUFFIX}`;
      }
      if (isSet(merged["VENDO_API_KEY"])) {
        return `your Vendo Cloud key (managed inference, ${DOWNLOAD_NOTE})`;
      }
      return null;
    },
    async run(input: ExtractionRunInput): Promise<string> {
      // Merge FIRST, then guard — the child is spawned with the caller's env
      // over process.env, so the own-credential verdict and composeGatewayFuel
      // must evaluate that same merged env. Guarding input.env alone would
      // let the overlay clobber an ambient (process.env) BYO endpoint the
      // child would otherwise have used. composeGatewayFuel already refuses
      // to overlay onto these env vars on its own (defense in depth) —
      // computed explicitly here too so this rung's own-credential verdict
      // matches availability()'s exactly, the same belt-and-suspenders style
      // as claude-cli-harness.ts.
      const merged = { ...process.env, ...input.env };
      const hasOwnKey = isSet(merged["ANTHROPIC_API_KEY"]) || hasOwnAnthropicEnvOverride(merged);
      const overlay = composeGatewayFuel({ env: merged, ownCredentialAvailable: hasOwnKey });

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
        env: { ...merged, ...overlay },
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
