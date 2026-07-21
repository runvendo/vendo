import type { EngineDeps, EngineJob, EngineRunResult } from "./types.js";

/**
 * The runner core. Deliberately dumb: drain `deps.query(job)`, route
 * "progress" messages to the caller's `onProgress` (stderr, in the real
 * CLI), and settle on the first "success" or "failure" message. No
 * knowledge of the Agent SDK, init, or any Vendo concept lives here — this
 * function is the entire "job in, final text out" contract, independent of
 * how the job actually gets executed.
 */
export async function runEngineJob(
  job: EngineJob,
  deps: EngineDeps,
  onProgress?: (line: string) => void,
): Promise<EngineRunResult> {
  for await (const message of deps.query(job)) {
    if (message.kind === "progress") {
      onProgress?.(message.text);
      continue;
    }
    if (message.kind === "success") {
      return { ok: true, text: message.text, errors: [] };
    }
    // "failure" — stop draining immediately; a failure message is terminal
    // by construction (sdk-seam.ts's `adapt` returns right after yielding one).
    return { ok: false, text: "", errors: message.errors };
  }
  // The stream closed without ever yielding a result. The real SDK always
  // terminates with a `result` message (success or error) per its own
  // contract, so reaching this is itself a bug worth surfacing loudly
  // rather than returning a silently-empty "success".
  return { ok: false, text: "", errors: ["engine stream ended without a result message"] };
}
