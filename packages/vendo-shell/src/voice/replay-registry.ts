/**
 * Read-only replay registry (context-engineering spec §3): the client-side
 * executor table that lets saved-view reopen re-run tools that do NOT go
 * through the server action route — browser-executed host tools and
 * bridge-executed integration tools.
 *
 * Register ONLY read-tier executors: reopen replay is a Yousef-ruled
 * reads-only surface (ENG-183). Registration is idempotent by name (latest
 * wins), and `replay` throws for unknown tools so callers can fall back to
 * their own path (or keep the snapshot).
 */

export interface ReplayRegistry {
  /** Register a read-tier executor for `tool`. Latest registration wins. */
  register(tool: string, execute: (input: unknown) => Promise<unknown>): void;
  has(tool: string): boolean;
  replay(tool: string, input: unknown): Promise<unknown>;
}

export function createReplayRegistry(): ReplayRegistry {
  const executors = new Map<string, (input: unknown) => Promise<unknown>>();
  return {
    register(tool, execute) {
      executors.set(tool, execute);
    },
    has(tool) {
      return executors.has(tool);
    },
    async replay(tool, input) {
      const execute = executors.get(tool);
      if (!execute) throw new Error(`tool "${tool}" is not in the replay registry`);
      return execute(input);
    },
  };
}

/** The shared default registry — hosts register read tools here and consult
 *  it from their RunQuery seam before any server fallback. */
export const replayRegistry: ReplayRegistry = createReplayRegistry();
