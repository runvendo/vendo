import type { DataQuery } from "@vendoai/core";

/**
 * Host-provided execution seam for reopening saved views: run one declared
 * data query through the host's normal (policy-governed) tool path and return
 * the tool result. Same shape as a stage ActionRequest on purpose — in
 * embedded demo-bank this is one fetch to /api/vendo/action.
 *
 * CONTRACT — reads only: implementations MUST refuse (throw for) any tool not
 * known to be non-mutating; the reopen flow then keeps the saved snapshot.
 * A mutating tool declared as a query must never execute on reopen. Hosts with
 * a published manifest should derive this from the frozen `mutating`/`dangerous`
 * annotations; hosts without one use an explicit allowlist.
 */
export type RunQuery = (query: DataQuery) => Promise<unknown>;
