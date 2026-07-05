"use client";

/**
 * The shell's RunQuery seam: replay one declared data query so a reopened
 * saved view shows fresh data.
 *
 * READS-ONLY: reopen replay may only execute tools the manifest marks
 * `mutating: false` — anything else throws BEFORE any call and the reopen
 * flow keeps the saved snapshot. (The extractor writes tools.json fail-closed
 * as all-mutating; relaxing an annotation there is the reviewed act that
 * makes a query replayable.)
 *
 * Host-API tools are CLIENT-executed (topology B): the replay runs
 * `executeHostToolCall` in this browser on the user's existing session,
 * exactly like the live agent path — it never transits the server handler.
 */
import { executeHostToolCall, type DataQuery, type ManifestTool } from "@flowlet/core";
import { manifestToolsToHostTools } from "@flowlet/server/manifest-tools";

export type RunQuery = (query: DataQuery) => Promise<unknown>;

export function createRunQuery(_basePath: string, tools: ManifestTool[]): RunQuery {
  const readOnlyDefs = new Map(
    manifestToolsToHostTools(tools.filter((t) => !t.annotations.mutating)).map((d) => [d.name, d]),
  );
  return async (query: DataQuery): Promise<unknown> => {
    const def = readOnlyDefs.get(query.tool);
    if (!def) {
      throw new Error(`query "${query.tool}" is not replayable on reopen (not read-only)`);
    }
    return executeHostToolCall(def, (query.input ?? {}) as Record<string, unknown>);
  };
}
