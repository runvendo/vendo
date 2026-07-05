/**
 * RunQuery seam: replay one declared data query through the SAME
 * policy-governed action route the sandbox uses. READS-ONLY (ENG-183 ruling):
 * reopen replay may only execute tools known to be non-mutating — anything
 * else throws BEFORE the network call and the reopen flow keeps the snapshot.
 */
const READ_ONLY_TOOLS = new Set(["list_unread_messages", "search_messages"]);

export async function runQuery(query) {
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
