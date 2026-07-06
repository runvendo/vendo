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
import {
  executeHostToolCall,
  manifestToolAnnotationsSchema,
  type DataQuery,
  type ManifestTool,
} from "@vendoai/core";
import { manifestToolsToHostTools } from "@vendoai/server/manifest-tools";

export type RunQuery = (query: DataQuery) => Promise<unknown>;

/** FAIL CLOSED: `tools` arrives from host props unvalidated, so a truthiness
 *  read of `annotations.mutating` would let an absent/forged annotation shape
 *  (`{}`, `mutating: 0`, no annotations at all) count as read-only. Only a
 *  shape that VALIDATES against the manifest contract and reads a literal
 *  `mutating: false` is replayable. */
function isValidatedReadOnly(tool: ManifestTool): boolean {
  const parsed = manifestToolAnnotationsSchema.safeParse(tool.annotations);
  return parsed.success && parsed.data.mutating === false;
}

export function createRunQuery(_basePath: string, tools: ManifestTool[]): RunQuery {
  const readOnlyDefs = new Map(
    manifestToolsToHostTools(tools.filter(isValidatedReadOnly)).map((d) => [d.name, d]),
  );
  return async (query: DataQuery): Promise<unknown> => {
    const def = readOnlyDefs.get(query.tool);
    if (!def) {
      throw new Error(`query "${query.tool}" is not replayable on reopen (not read-only)`);
    }
    return executeHostToolCall(def, (query.input ?? {}) as Record<string, unknown>);
  };
}
