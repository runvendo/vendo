import type { Readable } from "node:stream";
import { JobValidationError, parseJob, readJobFromStream } from "./job.js";
import { runEngineJob } from "./run-engine-job.js";
import { createSdkQuery } from "./sdk-seam.js";
import type { EngineDeps } from "./types.js";

/** I/O seam so tests can drive `runCli` without touching real stdio or the
 *  real SDK. `bin/vendo-engine.mjs` wires the real process.stdin/stdout/stderr
 *  and (via the default `deps` parameter below) the real Agent SDK query. */
export interface CliIo {
  stdin: Readable;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const PREFIX = "vendo-engine";

/**
 * `vendo-engine run` (also the default with no subcommand — the contract's
 * only entry point). Reads the job from `io.stdin`, runs it, and writes
 * EXACTLY the agent's final text to `io.stdout` — no banners, no logs, so a
 * caller can pipe stdout straight into its own artifact parser. Everything
 * else (progress narration, errors) goes to `io.stderr`. Returns the
 * process exit code; never throws.
 */
export async function runCli(
  argv: string[],
  io: CliIo,
  deps: EngineDeps = { query: createSdkQuery() },
): Promise<number> {
  const sub = argv[0] === undefined || argv[0].startsWith("-") ? "run" : argv[0];
  if (sub !== "run") {
    io.stderr(`${PREFIX}: unknown subcommand "${sub}" (only "run" is supported)\n`);
    return 1;
  }

  let raw: string;
  try {
    raw = await readJobFromStream(io.stdin);
  } catch (err) {
    io.stderr(`${PREFIX}: ${describeError(err)}\n`);
    return 1;
  }

  let job;
  try {
    job = parseJob(raw);
  } catch (err) {
    io.stderr(`${PREFIX}: ${describeError(err)}\n`);
    return 1;
  }

  let result;
  try {
    result = await runEngineJob(job, deps, (line) => io.stderr(`[${PREFIX}] ${line}\n`));
  } catch (err) {
    // A thrown error (e.g. the SDK subprocess failed to spawn at all) is a
    // failure, not a crash — the contract promises "non-zero exit, clear
    // error on stderr", not an uncaught rejection.
    io.stderr(`${PREFIX}: ${describeError(err)}\n`);
    return 1;
  }

  if (!result.ok) {
    io.stderr(`${PREFIX}: run failed: ${result.errors.join("; ")}\n`);
    return 1;
  }

  io.stdout(result.text);
  return 0;
}

function describeError(err: unknown): string {
  if (err instanceof JobValidationError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
