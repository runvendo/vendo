/**
 * demo-bank's RunQuery seam: replay one declared data query through the SAME
 * policy-governed action route the sandbox uses.
 *
 * READS-ONLY (Yousef ruling, ENG-183 gate): reopen replay may only execute
 * tools known to be non-mutating. Until the frozen manifest annotations flow
 * through ENG-202, that's this explicit allowlist — anything else throws
 * BEFORE the network call and the reopen flow keeps the saved snapshot.
 */
import type { DataQuery } from "@vendoai/core";
import { replayRegistry } from "@vendoai/shell";

/** Demo tools that are safe to re-run without the user asking. */
const READ_ONLY_TOOLS = new Set(["get_transactions"]);

export async function runQuery(query: DataQuery): Promise<unknown> {
  // Client-side replay registry first (spec §3): read-tier host tools run in
  // the browser and integration read tools go through the voice bridge —
  // neither exists on the server action route.
  if (replayRegistry.has(query.tool)) {
    return replayRegistry.replay(query.tool, query.input ?? {});
  }
  if (!READ_ONLY_TOOLS.has(query.tool)) {
    throw new Error(`query "${query.tool}" is not replayable on reopen (not read-only)`);
  }
  const res = await fetch("/api/vendo/action", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: query.tool, payload: query.input ?? {} }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? `query failed (${res.status})`);
  if (json.needsApproval === true) throw new Error(`query "${query.tool}" requires approval`);
  return json.result;
}
