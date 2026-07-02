/**
 * demo-bank's RunQuery seam: replay one declared data query through the SAME
 * policy-governed action route the sandbox uses.
 *
 * READS-ONLY (Yousef ruling, ENG-183 gate): reopen replay may only execute
 * tools known to be non-mutating. Until the frozen manifest annotations flow
 * through ENG-202, that's this explicit allowlist — anything else throws
 * BEFORE the network call and the reopen flow keeps the saved snapshot.
 */
import type { DataQuery } from "@flowlet/core";

/** Demo tools that are safe to re-run without the user asking. */
const READ_ONLY_TOOLS = new Set(["get_transactions"]);

export async function runQuery(query: DataQuery): Promise<unknown> {
  if (!READ_ONLY_TOOLS.has(query.tool)) {
    throw new Error(`query "${query.tool}" is not replayable on reopen (not read-only)`);
  }
  const res = await fetch("/api/flowlet/action", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: query.tool, payload: query.input ?? {} }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? `query failed (${res.status})`);
  if (json.needsApproval === true) throw new Error(`query "${query.tool}" requires approval`);
  return json.result;
}
