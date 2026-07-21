/**
 * The whole cross-repo contract lives here: a job in, a result out. Nothing
 * in this file (or in run-engine-job.ts, which is the only file that reads
 * it) may import the real `@anthropic-ai/claude-agent-sdk` package — that
 * import is confined to sdk-seam.ts, and only inside a dynamic `import()`
 * that fires at run time, never at module-load time. That is what lets
 * unit tests (and typecheck of the core) exercise this package without ever
 * resolving the SDK's ~245MB platform binary.
 */

/** Stdin shape, verbatim from the harness that invokes `vendo-engine run`. */
export interface EngineJob {
  /** The full task prompt for the agent. Opaque to this package. */
  instructions: string;
  /** Absolute path the read-only tool policy is rooted at (session cwd). */
  root: string;
}

/**
 * A hand-rolled, minimal projection of the Agent SDK's message stream —
 * only the three shapes the runner core actually branches on. Real SDK
 * messages carry dozens of variants (see sdk-seam.ts's `adapt`); everything
 * else collapses into "progress" narration.
 */
export type EngineMessage =
  | { kind: "progress"; text: string }
  | { kind: "success"; text: string }
  | { kind: "failure"; errors: string[] };

/** The injectable seam. Tests script this directly; the CLI wires the real
 *  Agent SDK session through sdk-seam.ts's `createSdkQuery()`. */
export interface EngineDeps {
  query(job: EngineJob): AsyncIterable<EngineMessage>;
}

export interface EngineRunResult {
  ok: boolean;
  /** The agent's final message text. Only meaningful when `ok` is true. */
  text: string;
  /** Populated only when `ok` is false. */
  errors: string[];
}
