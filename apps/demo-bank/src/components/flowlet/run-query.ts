/**
 * demo-bank's RunQuery seam: replay one declared data query through the SAME
 * policy-governed action route the sandbox uses. Reads are ALWAYS_ALLOW in the
 * demo policy; anything approval-gated or denied throws, and the reopen flow
 * falls back to the saved snapshot.
 */
import type { DataQuery } from "@flowlet/core";

export async function runQuery(query: DataQuery): Promise<unknown> {
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
