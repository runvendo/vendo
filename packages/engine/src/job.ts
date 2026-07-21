import { isAbsolute } from "node:path";
import type { Readable } from "node:stream";
import type { EngineJob } from "./types.js";

/** Generous headroom for `{instructions, root}` — both plain strings — not
 *  a budget to fill. Guards against a misbehaving caller piping something
 *  unbounded into stdin; the read loop aborts (and destroys the stream, so
 *  it stops pulling more data) the moment this is exceeded, rather than
 *  buffering everything first and rejecting only after the fact. */
export const JOB_MAX_BYTES = 1024 * 1024;

export class JobValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobValidationError";
  }
}

/** Reads stdin (or any Readable) to a UTF-8 string, enforcing JOB_MAX_BYTES. */
export async function readJobFromStream(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buf.length;
    if (total > JOB_MAX_BYTES) {
      stream.destroy();
      throw new JobValidationError(`job input exceeds ${JOB_MAX_BYTES} bytes`);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Parses and validates the job contract. Every failure is a
 *  JobValidationError with a message specific enough to fix without
 *  reading this file — malformed input must never reach the SDK seam. */
export function parseJob(raw: string): EngineJob {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new JobValidationError("job input is not valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new JobValidationError("job input must be a JSON object");
  }
  const { instructions, root } = value as Record<string, unknown>;

  if (typeof instructions !== "string" || instructions.trim().length === 0) {
    throw new JobValidationError('job.instructions must be a non-empty string');
  }
  if (typeof root !== "string" || root.trim().length === 0) {
    throw new JobValidationError('job.root must be a non-empty string');
  }
  // Relative roots would resolve against this process's own cwd, not the
  // caller's intended host directory — fail closed instead of guessing.
  if (!isAbsolute(root)) {
    throw new JobValidationError("job.root must be an absolute path");
  }

  return { instructions, root };
}
